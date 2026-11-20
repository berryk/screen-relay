#include "server/stream-hub.hpp"
#include "core/wait.hpp"
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

namespace {
using namespace std::chrono_literals;

void require(bool condition, const char* message) {
  if (!condition) {
    std::fprintf(stderr, "stream-hub-test failed: %s\n", message);
    std::exit(1);
  }
}

struct FakeSourceState {
  relay::Wake wake;
  std::atomic<unsigned> captures{0};
  std::atomic<uint8_t> shade{64};
  void damage() { wake.signal(); }
};

class FakeSource final : public relay::CaptureSource {
 public:
  explicit FakeSource(std::shared_ptr<FakeSourceState> s) : s_(std::move(s)), pixels_(640 * 360 * 4) {}
  relay::WaitHandle fd() const override { return s_->wake.handle(); }
  std::pair<int, int> dimensions() const override { return {640, 360}; }
  bool drainDamage() override { return s_->wake.consume(); }
  relay::PixelFormat pixelFormat() const override { return relay::PixelFormat::BGRA; }
  relay::FrameView capture() override {
    ++s_->captures;
    const uint8_t v = s_->shade.load();
    for (size_t i = 0; i < pixels_.size(); i += 4) {
      pixels_[i] = v; pixels_[i + 1] = uint8_t(v + 30); pixels_[i + 2] = uint8_t(255 - v); pixels_[i + 3] = 255;
    }
    return {pixels_.data(), 640 * 4, 640, 360, relay::PixelFormat::BGRA};
  }
 private:
  std::shared_ptr<FakeSourceState> s_;
  std::vector<uint8_t> pixels_;
};

uint64_t nowUs() {
  return uint64_t(std::chrono::duration_cast<std::chrono::microseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
}

bool waitPacket(relay::StreamHub& hub, const std::shared_ptr<relay::StreamHub::Subscriber>& sub,
                relay::ViewerPacket& out, std::chrono::milliseconds timeout = 3000ms) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    std::optional<relay::ViewerPacket> pkt;
    std::optional<relay::CursorImage> cur;
    bool failed = false, more = false;
    if (hub.popOutbound(sub, pkt, cur, failed, more) && pkt) {
      out = std::move(*pkt);
      return true;
    }
    require(!failed, "subscriber unexpectedly failed while waiting for packet");
    std::this_thread::sleep_for(5ms);
  }
  return false;
}
}  // namespace

int main() {
  using namespace relay;
  auto src = std::make_shared<FakeSourceState>();
  std::atomic<unsigned> wakes{0};
  StreamHub hub(CaptureSettings{60, 1000000, 8000000, 40000000, "auto"},
                [src] { return std::make_unique<FakeSource>(src); },
                [&] { ++wakes; });

  require(hub.state() == HubState::stopped, "initial hub state must be stopped");
  std::string err;
  require(hub.start(err), "hub.start failed");
  require(hub.state() == HubState::idle, "started hub must be idle");
  require(src->captures == 0, "idle hub must not capture");

  auto ctrl = hub.attach(SubscriberRole::controller, 10, false);
  require(ctrl && hub.state() == HubState::streaming && hub.subscriberCount() == 1, "controller attach failed");
  ViewerPacket p1;
  require(waitPacket(hub, ctrl, p1), "controller did not receive initial IDR");
  require(p1.sequence == 1 && p1.frame && p1.frame->keyframe, "first controller packet must be IDR");
  require(hub.markSent(ctrl, 1, nowUs()), "markSent ctrl 1 failed");
  require(hub.acknowledge(ctrl, 10, 1, nowUs(), 0), "ack ctrl 1 failed");

  auto watch = hub.attach(SubscriberRole::watch, 11, false);
  require(watch && hub.subscriberCount() == 2, "watch attach failed");
  src->shade = 120;
  src->damage();
  ViewerPacket c2, w1;
  require(waitPacket(hub, ctrl, c2), "controller did not receive second frame");
  require(hub.markSent(ctrl, c2.sequence, nowUs()), "markSent ctrl 2 failed");
  require(hub.acknowledge(ctrl, 10, c2.sequence, nowUs(), 0), "ack ctrl 2 failed");
  require(waitPacket(hub, watch, w1), "watch did not receive initial IDR");
  require(w1.sequence == 1 && w1.frame && w1.frame->keyframe, "first watch packet must be IDR");
  require(hub.markSent(watch, 1, nowUs()), "markSent watch 1 failed");
  require(hub.acknowledge(watch, 11, 1, nowUs(), 0), "ack watch 1 failed");

  std::mutex rtc_mtx;
  std::condition_variable rtc_cv;
  std::vector<std::shared_ptr<const EncodedFrame>> rtc_frames;
  auto rtc = hub.attach(SubscriberRole::rtc, 12, false, [&](const std::shared_ptr<const EncodedFrame>& f) {
    {
      std::lock_guard<std::mutex> lock(rtc_mtx);
      rtc_frames.push_back(f);
    }
    rtc_cv.notify_all();
  });
  require(rtc && hub.subscriberCount() == 3, "rtc attach failed");
  src->shade = 180;
  src->damage();

  {
    std::unique_lock<std::mutex> lock(rtc_mtx);
    require(rtc_cv.wait_for(lock, 3000ms, [&] { return !rtc_frames.empty(); }), "rtc did not receive frame");
    require(rtc_frames.front()->keyframe, "first rtc frame must be IDR");
  }

  hub.detach(ctrl->id);
  require(hub.state() == HubState::streaming && hub.subscriberCount() == 2, "detach controller broke streaming");
  src->shade = 210;
  src->damage();
  ViewerPacket w_after;
  require(waitPacket(hub, watch, w_after), "watch stalled after controller detach");
  require(w_after.sequence >= 2, "watch sequence did not advance");
  require(hub.markSent(watch, w_after.sequence, nowUs()), "markSent watch after handoff failed");
  require(hub.acknowledge(watch, 11, w_after.sequence, nowUs(), 0), "ack watch after handoff failed");

  hub.detach(watch->id);
  hub.detach(rtc->id);
  require(hub.state() == HubState::idle && hub.subscriberCount() == 0, "hub did not return to idle");

  {
    auto slow_watch = hub.attach(SubscriberRole::watch, 20, false);
    require(slow_watch != nullptr, "proxy-mode slow_watch attach failed");
    unsigned window = 0;
    uint64_t deadline = 0;
    uint32_t lowat = 0;
    hub.updateFlow(slow_watch, nowUs(), std::nullopt, window, deadline, lowat);
    ViewerPacket sw1;
    require(waitPacket(hub, slow_watch, sw1), "slow_watch did not receive initial IDR");
    require(sw1.frame && sw1.frame->keyframe, "slow_watch initial frame must be IDR");
    require(hub.markSent(slow_watch, sw1.sequence, nowUs()), "markSent slow_watch 1 failed");

    auto joining_ctrl = hub.attach(SubscriberRole::controller, 22, false);
    require(joining_ctrl != nullptr, "joining_ctrl attach failed");
    hub.updateFlow(joining_ctrl, nowUs(), std::nullopt, window, deadline, lowat);
    ViewerPacket jc1;
    require(waitPacket(hub, joining_ctrl, jc1), "controller stalled when watch withheld first ACK");
    require(jc1.sequence == 1 && jc1.frame && jc1.frame->keyframe, "joining_ctrl first packet must be IDR");
    require(hub.viewerState(joining_ctrl) == ViewerState::streaming, "joining_ctrl did not transition to streaming");
    require(hub.markSent(joining_ctrl, jc1.sequence, nowUs()), "markSent joining_ctrl 1 failed");
    require(hub.acknowledge(joining_ctrl, 22, jc1.sequence, nowUs(), 0), "ack joining_ctrl 1 failed");

    src->shade = 90;
    src->damage();
    ViewerPacket jc2;
    require(waitPacket(hub, joining_ctrl, jc2), "controller stalled on second frame while watch withheld ACK");
    require(jc2.sequence == 2, "controller second frame sequence mismatch");

    hub.detach(slow_watch->id);
    hub.detach(joining_ctrl->id);
    require(hub.state() == HubState::idle && hub.subscriberCount() == 0, "proxy-mode cleanup failed");
  }

  {
    auto stalled_watch = hub.attach(SubscriberRole::watch, 30, false);
    auto healthy_watch = hub.attach(SubscriberRole::watch, 31, false);
    require(stalled_watch && healthy_watch, "multi-watch attach failed");
    ViewerPacket s1, h1;
    require(waitPacket(hub, stalled_watch, s1), "stalled_watch initial IDR missing");
    require(waitPacket(hub, healthy_watch, h1), "healthy_watch initial IDR missing");
    require(hub.markSent(stalled_watch, s1.sequence, nowUs()), "markSent stalled_watch failed");
    require(hub.markSent(healthy_watch, h1.sequence, nowUs()), "markSent healthy_watch failed");
    require(hub.acknowledge(healthy_watch, 31, h1.sequence, nowUs(), 0), "ack healthy_watch 1 failed");

    unsigned window = 0;
    uint64_t deadline = 0;
    uint32_t lowat = 0;
    hub.updateFlow(stalled_watch, nowUs(), std::nullopt, window, deadline, lowat);

    for (uint32_t i = 0; i < 3; ++i) {
      src->shade = uint8_t(40 + i * 35);
      src->damage();
      ViewerPacket next;
      require(waitPacket(hub, healthy_watch, next), "healthy watch stalled by paused spectator");
      require(hub.markSent(healthy_watch, next.sequence, nowUs()), "markSent healthy_watch next failed");
      require(hub.acknowledge(healthy_watch, 31, next.sequence, nowUs(), 0), "ack healthy_watch next failed");
    }

    hub.detach(stalled_watch->id);
    hub.detach(healthy_watch->id);
    require(hub.state() == HubState::idle, "multi-watch cleanup failed");
  }

  {
    auto aged = hub.attach(SubscriberRole::watch, 40, false);
    require(aged != nullptr, "aged watch attach failed");
    const uint64_t attached = aged->attached_us;
    require(!hub.timedOut(aged, attached), "freshly attached subscriber should not time out");
    require(hub.timedOut(aged, attached + FlowControl::timeout_us), "unfulfilled initial IDR must time out");
    ViewerPacket a1;
    require(waitPacket(hub, aged, a1), "aged watch did not receive initial IDR");
    require(hub.markSent(aged, a1.sequence, nowUs()), "markSent aged 1 failed");
    require(hub.acknowledge(aged, 40, a1.sequence, nowUs(), 0), "ack aged 1 failed");
    const uint64_t later = attached + FlowControl::timeout_us * 2;
    aged->state = ViewerState::awaiting_idr;
    aged->awaiting_idr_since_us = later;
    require(!hub.timedOut(aged, later), "established subscriber entering awaiting_idr timed out immediately");
    require(hub.timedOut(aged, later + FlowControl::timeout_us), "awaiting_idr recovery deadline was not enforced");
    hub.detach(aged->id);
  }

  hub.stop();
  require(hub.state() == HubState::stopped, "stopped hub must report stopped");
  std::puts("stream hub state machine checks passed");
  return 0;
}
