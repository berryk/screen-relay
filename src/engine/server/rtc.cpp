#include "rtc.hpp"
#ifdef RELAY_RTC
#include <rtc/rtc.hpp>
#endif
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstring>
#include <iostream>
#include <mutex>
#include <thread>
#include <utility>
#include <variant>

namespace relay {

const char* rtcStateName(RtcState state) {
  switch (state) {
    case RtcState::idle: return "idle";
    case RtcState::gathering: return "gathering";
    case RtcState::connecting: return "connecting";
    case RtcState::connected: return "connected";
    case RtcState::closing: return "closing";
    case RtcState::closed: return "closed";
  }
  return "unknown";
}

namespace {
#ifdef RELAY_RTC
constexpr uint32_t video_ssrc = 0x52454c59;
constexpr size_t max_queued_rtc_input = 1024;

bool isHexDigit(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

std::string normalizeProfileLevelId(const std::string& raw) {
  if (raw.size() != 6 || !std::all_of(raw.begin(), raw.end(), isHexDigit)) return {};
  std::string out = raw;
  for (char& c : out) if (c >= 'A' && c <= 'F') c = char(c - 'A' + 'a');
  return out;
}

std::string lowercase(std::string text) {
  for (char& c : text) if (c >= 'A' && c <= 'Z') c = char(c - 'A' + 'a');
  return text;
}

/** Selects the H.264 payload type from an offer video section matching packetization-mode=1. */
int h264PayloadType(const rtc::Description::Media& media, const std::string& preferred_plid) {
  int fallback_42e0 = -1;
  int fallback_any = -1;
  for (const int pt : media.payloadTypes()) {
    const auto* map = media.rtpMap(pt);
    if (!map || map->format != "H264") continue;
    std::string fmtp;
    for (const auto& f : map->fmtps) fmtp += lowercase(f) + ";";
    if (fmtp.find("packetization-mode=1") == std::string::npos) continue;
    if (!preferred_plid.empty() && fmtp.find("profile-level-id=" + preferred_plid) != std::string::npos) return pt;
    if (fallback_42e0 < 0 && fmtp.find("42e01f") != std::string::npos) fallback_42e0 = pt;
    if (fallback_any < 0) fallback_any = pt;
  }
  return fallback_42e0 >= 0 ? fallback_42e0 : fallback_any;
}
#endif
}  // namespace

struct RtcSession::Impl : public std::enable_shared_from_this<Impl> {
  std::vector<IceServer> ice_servers;
  bool can_send_input = false;
  RtcCallbacks callbacks;
  mutable std::mutex mutex;
  std::condition_variable cv;
  std::thread gather_thread;
  RtcState state = RtcState::idle;
  bool answer_ready = false;
  bool awaiting_keyframe = true;
  bool gathering_complete = false;
  std::string answer_sdp;
  std::string error;
  std::deque<std::array<uint8_t, 16>> input;
#ifdef RELAY_RTC
  std::shared_ptr<rtc::PeerConnection> pc;
  std::shared_ptr<rtc::Track> track;
  std::shared_ptr<rtc::DataChannel> channel;
#endif

  Impl(std::vector<IceServer> servers, bool allow_input, RtcCallbacks cb)
      : ice_servers(std::move(servers)), can_send_input(allow_input), callbacks(std::move(cb)) {}

  void wake() const {
    if (callbacks.wake) callbacks.wake();
  }

  void join() {
    if (gather_thread.joinable() && gather_thread.get_id() != std::this_thread::get_id()) {
      gather_thread.join();
    }
  }

  void fail(const std::string& reason) {
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (!answer_ready) {
        error = reason;
        answer_sdp.clear();
        answer_ready = true;
      }
      state = RtcState::closed;
      cv.notify_all();
    }
    wake();
  }

  void close() {
#ifdef RELAY_RTC
    std::shared_ptr<rtc::DataChannel> dc;
    std::shared_ptr<rtc::Track> tr;
    std::shared_ptr<rtc::PeerConnection> peer;
#endif
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (state == RtcState::closed) return;
      state = RtcState::closing;
      if (!answer_ready) {
        error = "rtc_closed";
        answer_sdp.clear();
        answer_ready = true;
      }
      state = RtcState::closed;
      cv.notify_all();
#ifdef RELAY_RTC
      dc = std::move(channel);
      tr = std::move(track);
      peer = std::move(pc);
#endif
    }
#ifdef RELAY_RTC
    if (dc) dc->close();
    if (tr) tr->close();
    if (peer) peer->close();
#endif
    wake();
  }

  void startOffer(std::string offer_sdp) {
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (state != RtcState::idle) return;
      state = RtcState::gathering;
      answer_ready = false;
      awaiting_keyframe = true;
      gathering_complete = false;
      answer_sdp.clear();
      error.clear();
    }
    auto self = shared_from_this();
    gather_thread = std::thread([self = std::move(self), offer = std::move(offer_sdp)]() mutable {
      self->runOffer(std::move(offer));
    });
  }

  void runOffer(std::string offer_sdp) {
#ifndef RELAY_RTC
    (void)offer_sdp;
    fail("rtc_disabled");
#else
    try {
      rtc::Description offer(offer_sdp, rtc::Description::Type::Offer);
      std::string preferred_plid;
      if (callbacks.profile_level_id) {
        preferred_plid = normalizeProfileLevelId(callbacks.profile_level_id());
      }
      const std::string answer_plid = preferred_plid.empty() ? std::string("42e01f") : preferred_plid;

      std::string mid;
      int pt = -1;
      for (int i = 0; i < offer.mediaCount(); ++i) {
        const auto entry = offer.media(i);
        if (!std::holds_alternative<rtc::Description::Media*>(entry)) continue;
        const auto* media = std::get<rtc::Description::Media*>(entry);
        if (!media || media->type() != "video") continue;
        mid = media->mid();
        pt = h264PayloadType(*media, preferred_plid);
        break;
      }
      if (mid.empty() || pt < 0) {
        fail("no_h264");
        return;
      }

      rtc::Configuration config;
      config.disableAutoNegotiation = false;
      for (const auto& server : ice_servers) {
        config.iceServers.emplace_back(server.raw);
      }

      auto peer = std::make_shared<rtc::PeerConnection>(config);
      rtc::Description::Video video(mid, rtc::Description::Direction::SendOnly);
      video.addH264Codec(pt, "profile-level-id=" + answer_plid + ";packetization-mode=1;level-asymmetry-allowed=1");
      video.addSSRC(video_ssrc, "relay");
      auto tr = peer->addTrack(video);
      auto rtp = std::make_shared<rtc::RtpPacketizationConfig>(video_ssrc, "relay", uint8_t(pt), rtc::H264RtpPacketizer::ClockRate);
      auto packetizer = std::make_shared<rtc::H264RtpPacketizer>(rtc::NalUnit::Separator::StartSequence, rtp);
      packetizer->addToChain(std::make_shared<rtc::RtcpSrReporter>(rtp));
      packetizer->addToChain(std::make_shared<rtc::RtcpNackResponder>());

      std::weak_ptr<Impl> weak = shared_from_this();
      packetizer->addToChain(std::make_shared<rtc::PliHandler>([weak] {
        if (auto self = weak.lock()) {
          {
            std::lock_guard<std::mutex> lock(self->mutex);
            if (self->state == RtcState::closed || self->state == RtcState::closing) return;
            self->awaiting_keyframe = true;
          }
          if (self->callbacks.request_keyframe) self->callbacks.request_keyframe();
        }
      }));
      tr->setMediaHandler(packetizer);
      tr->onOpen([weak] {
        if (auto self = weak.lock()) {
          {
            std::lock_guard<std::mutex> lock(self->mutex);
            if (self->state == RtcState::closed || self->state == RtcState::closing) return;
            self->state = RtcState::connected;
            self->awaiting_keyframe = true;
          }
          if (self->callbacks.request_keyframe) self->callbacks.request_keyframe();
          self->wake();
        }
      });

      peer->onDataChannel([weak](std::shared_ptr<rtc::DataChannel> dc) {
        auto self = weak.lock();
        if (!self || !dc || dc->label() != "input" || !self->can_send_input) return;
        {
          std::lock_guard<std::mutex> lock(self->mutex);
          if (self->state == RtcState::closed || self->state == RtcState::closing) return;
          self->channel = dc;
        }
        dc->onMessage([weak](rtc::message_variant message) {
          auto self = weak.lock();
          if (!self || !std::holds_alternative<rtc::binary>(message)) return;
          const auto& bytes = std::get<rtc::binary>(message);
          if (bytes.size() != 16) return;
          std::array<uint8_t, 16> record{};
          std::memcpy(record.data(), bytes.data(), 16);
          {
            std::lock_guard<std::mutex> lock(self->mutex);
            if (self->state == RtcState::closed || self->state == RtcState::closing) return;
            if (self->input.size() < max_queued_rtc_input) self->input.push_back(record);
          }
          self->wake();
        });
      });

      peer->onStateChange([weak](rtc::PeerConnection::State s) {
        auto self = weak.lock();
        if (!self) return;
        bool should_wake = false;
        {
          std::lock_guard<std::mutex> lock(self->mutex);
          if (self->state == RtcState::closed || self->state == RtcState::closing) return;
          if (s == rtc::PeerConnection::State::Connected) {
            self->state = RtcState::connected;
            should_wake = true;
          } else if (s == rtc::PeerConnection::State::Failed || s == rtc::PeerConnection::State::Closed ||
                     s == rtc::PeerConnection::State::Disconnected) {
            self->state = RtcState::closed;
            self->cv.notify_all();
            should_wake = true;
          }
        }
        if (should_wake) self->wake();
      });

      peer->onGatheringStateChange([weak](rtc::PeerConnection::GatheringState s) {
        if (s != rtc::PeerConnection::GatheringState::Complete) return;
        if (auto self = weak.lock()) {
          std::lock_guard<std::mutex> lock(self->mutex);
          self->gathering_complete = true;
          self->cv.notify_all();
        }
      });

      {
        std::lock_guard<std::mutex> lock(mutex);
        if (state == RtcState::closed || state == RtcState::closing) {
          lock.~lock_guard();
          peer->close();
          return;
        }
        pc = peer;
        track = tr;
      }

      peer->setRemoteDescription(offer);
      {
        std::unique_lock<std::mutex> lock(mutex);
        cv.wait_for(lock, std::chrono::seconds(2), [this] {
          return gathering_complete || state == RtcState::closed || state == RtcState::closing;
        });
        if (state == RtcState::closed || state == RtcState::closing) return;
      }

      const auto local = peer->localDescription();
      if (!local) {
        peer->close();
        fail("no_answer");
        return;
      }
      {
        std::lock_guard<std::mutex> lock(mutex);
        if (state == RtcState::closed || state == RtcState::closing) return;
        answer_sdp = std::string(*local);
        error.clear();
        answer_ready = true;
        if (state == RtcState::gathering) state = RtcState::connecting;
      }
      wake();
    } catch (const std::exception& ex) {
      fail(ex.what());
    }
#endif
  }

  void pushFrame(const std::shared_ptr<const EncodedFrame>& frame) {
    if (!frame) return;
#ifdef RELAY_RTC
    std::shared_ptr<rtc::Track> tr;
    bool awaiting = true;
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (state != RtcState::connected || !track) return;
      tr = track;
      awaiting = awaiting_keyframe;
    }
    if (!tr->isOpen() || (awaiting && !frame->keyframe)) return;
    try {
      tr->sendFrame(reinterpret_cast<const std::byte*>(frame->annex_b.data()), frame->annex_b.size(),
                    rtc::FrameInfo(std::chrono::duration<double, std::micro>(double(frame->pts_us))));
      if (frame->keyframe) {
        std::lock_guard<std::mutex> lock(mutex);
        awaiting_keyframe = false;
      }
    } catch (const std::exception& ex) {
      std::cerr << "RTC send failed: " << ex.what() << '\n';
    }
#else
    (void)frame;
#endif
  }

  bool takeAnswer(std::string& out_answer, std::string& out_error) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!answer_ready) return false;
    out_answer = answer_sdp;
    out_error = error;
    return true;
  }

  std::deque<std::array<uint8_t, 16>> takeInput() {
    std::lock_guard<std::mutex> lock(mutex);
    return std::exchange(input, {});
  }
};

RtcSession::RtcSession(std::vector<IceServer> ice_servers, bool can_send_input, RtcCallbacks callbacks)
    : impl_(std::make_shared<Impl>(std::move(ice_servers), can_send_input, std::move(callbacks))) {}

RtcSession::~RtcSession() {
  if (impl_) {
    impl_->close();
    impl_->join();
  }
}

void RtcSession::startOffer(std::string offer_sdp) { impl_->startOffer(std::move(offer_sdp)); }
bool RtcSession::takeAnswer(std::string& answer_sdp, std::string& error) { return impl_->takeAnswer(answer_sdp, error); }
void RtcSession::pushFrame(const std::shared_ptr<const EncodedFrame>& frame) { impl_->pushFrame(frame); }
std::deque<std::array<uint8_t, 16>> RtcSession::takeInput() { return impl_->takeInput(); }
void RtcSession::close() { impl_->close(); }
RtcState RtcSession::state() const { std::lock_guard<std::mutex> lock(impl_->mutex); return impl_->state; }
bool RtcSession::canSendInput() const { std::lock_guard<std::mutex> lock(impl_->mutex); return impl_->can_send_input && impl_->state != RtcState::closed; }
bool RtcSession::closed() const { std::lock_guard<std::mutex> lock(impl_->mutex); return impl_->state == RtcState::closed; }

}  // namespace relay
