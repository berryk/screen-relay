#include "server/stream-hub.hpp"
#include "core/wait.hpp"
#include <atomic>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <mutex>
#include <thread>
#include <vector>

namespace {
using namespace std::chrono_literals;

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
    assert(!failed);
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

  assert(hub.state() == HubState::stopped);
  std::string err;
  assert(hub.start(err));
  assert(hub.state() == HubState::idle);
  assert(src->captures == 0);

  auto ctrl = hub.attach(SubscriberRole::controller, 10, false);
  assert(ctrl && hub.state() == HubState::streaming && hub.subscriberCount() == 1);
  ViewerPacket p1;
  assert(waitPacket(hub, ctrl, p1));
  assert(p1.sequence == 1 && p1.frame && p1.frame->keyframe);
  assert(hub.markSent(ctrl, 1, nowUs()));
  assert(hub.acknowledge(ctrl, 10, 1, nowUs(), 0));

  auto watch = hub.attach(SubscriberRole::watch, 11, false);
  assert(watch && hub.subscriberCount() == 2);
  src->shade = 120;
  src->damage();
  ViewerPacket c2, w1;
  assert(waitPacket(hub, ctrl, c2));
  assert(hub.markSent(ctrl, c2.sequence, nowUs()));
  assert(hub.acknowledge(ctrl, 10, c2.sequence, nowUs(), 0));
  assert(waitPacket(hub, watch, w1));
  assert(w1.sequence == 1 && w1.frame && w1.frame->keyframe);
  assert(hub.markSent(watch, 1, nowUs()));
  assert(hub.acknowledge(watch, 11, 1, nowUs(), 0));

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
  assert(rtc && hub.subscriberCount() == 3);
  src->shade = 180;
  src->damage();

  {
    std::unique_lock<std::mutex> lock(rtc_mtx);
    assert(rtc_cv.wait_for(lock, 3000ms, [&] { return !rtc_frames.empty(); }));
    assert(rtc_frames.front()->keyframe);
  }

  hub.detach(ctrl->id);
  assert(hub.state() == HubState::streaming && hub.subscriberCount() == 2);
  src->shade = 210;
  src->damage();
  ViewerPacket w_after;
  assert(waitPacket(hub, watch, w_after));
  assert(w_after.sequence >= 2);
  assert(hub.markSent(watch, w_after.sequence, nowUs()));
  assert(hub.acknowledge(watch, 11, w_after.sequence, nowUs(), 0));

  hub.detach(watch->id);
  hub.detach(rtc->id);
  assert(hub.state() == HubState::idle && hub.subscriberCount() == 0);

  hub.stop();
  assert(hub.state() == HubState::stopped);
  std::puts("stream hub state machine checks passed");
  return 0;
}
