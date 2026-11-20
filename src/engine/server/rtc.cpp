#ifdef RELAY_RTC
#include "rtc.hpp"
#include <rtc/rtc.hpp>
#include <libwebsockets.h>
#include <chrono>
#include <cstring>
#include <future>
#include <iostream>
#include <variant>

namespace relay {
namespace {
constexpr uint32_t video_ssrc = 0x52454c59;
/** The H.264 payload type in the offer's first video section, preferring packetization-mode=1 with profile 42e01f. */
int h264PayloadType(const rtc::Description::Media& media) {
  int fallback = -1;
  for (const int pt : media.payloadTypes()) {
    const auto* map = media.rtpMap(pt);
    if (!map || map->format != "H264") continue;
    std::string fmtp;
    for (const auto& f : map->fmtps) fmtp += f + ";";
    if (fmtp.find("packetization-mode=1") == std::string::npos) continue;
    if (fmtp.find("42e01f") != std::string::npos) return pt;
    if (fallback < 0) fallback = pt;
  }
  return fallback;
}
}  // namespace

RtcSession::RtcSession(CaptureSettings s, CaptureSourceFactory factory, lws_context* ctx)
    : settings(s), context(ctx), capture([this](EncodedFrame&& frame) { send(std::move(frame)); return true; }, s, std::move(factory)) {}

RtcSession::~RtcSession() {
  { std::lock_guard<std::mutex> lock(mutex); ended = true; }
  capture.stop();
  if (pc) pc->close();
}

bool RtcSession::answer(const std::string& offerSdp, std::string& answerSdp, std::string& error) {
  std::string startError;
  if (!capture.start(startError)) { error = "capture_failed"; std::cerr << "RTC capture startup failed: " << startError << '\n'; return false; }
  rtc::Description offer(offerSdp, rtc::Description::Type::Offer);
  std::string mid; int pt = -1;
  for (int i = 0; i < offer.mediaCount(); ++i) {
    const auto entry = offer.media(i);
    if (!std::holds_alternative<rtc::Description::Media*>(entry)) continue;
    const auto* media = std::get<rtc::Description::Media*>(entry);
    if (media->type() != "video") continue;
    mid = media->mid(); pt = h264PayloadType(*media);
    break;
  }
  if (mid.empty() || pt < 0) { error = "no_h264"; return false; }
  rtc::Configuration config;
  config.iceServers.emplace_back("stun:stun.l.google.com:19302");
  config.disableAutoNegotiation = false;
  pc = std::make_shared<rtc::PeerConnection>(config);
  std::weak_ptr<RtcSession> weak = shared_from_this();
  rtc::Description::Video video(mid, rtc::Description::Direction::SendOnly);
  video.addH264Codec(pt, "profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1");
  video.addSSRC(video_ssrc, "relay");
  track = pc->addTrack(video);
  auto rtp = std::make_shared<rtc::RtpPacketizationConfig>(video_ssrc, "relay", uint8_t(pt), rtc::H264RtpPacketizer::ClockRate);
  auto packetizer = std::make_shared<rtc::H264RtpPacketizer>(rtc::NalUnit::Separator::StartSequence, rtp);
  packetizer->addToChain(std::make_shared<rtc::RtcpSrReporter>(rtp));
  packetizer->addToChain(std::make_shared<rtc::RtcpNackResponder>());
  packetizer->addToChain(std::make_shared<rtc::PliHandler>([weak] { if (auto self = weak.lock()) self->restart(); }));
  track->setMediaHandler(packetizer);
  track->onOpen([weak] { if (auto self = weak.lock()) self->restart(); });
  pc->onDataChannel([weak](std::shared_ptr<rtc::DataChannel> dc) {
    auto self = weak.lock();
    if (!self || dc->label() != "input") return;
    self->channel = dc;
    dc->onMessage([weak](rtc::message_variant message) {
      auto self = weak.lock();
      if (!self || !std::holds_alternative<rtc::binary>(message)) return;
      const auto& bytes = std::get<rtc::binary>(message);
      if (bytes.size() != 16) return;
      std::array<uint8_t, 16> record;
      std::memcpy(record.data(), bytes.data(), 16);
      { std::lock_guard<std::mutex> lock(self->mutex); if (self->input.size() < 1024) self->input.push_back(record); }
      lws_cancel_service(self->context);
    });
  });
  pc->onStateChange([weak](rtc::PeerConnection::State state) {
    auto self = weak.lock();
    if (!self) return;
    if (state == rtc::PeerConnection::State::Failed || state == rtc::PeerConnection::State::Closed ||
        state == rtc::PeerConnection::State::Disconnected) {
      uint32_t old;
      { std::lock_guard<std::mutex> lock(self->mutex); self->ended = true; self->open = false; old = self->generation; }
      self->capture.endSession(old);
    }
  });
  auto gathered = std::make_shared<std::promise<void>>();
  auto done = gathered->get_future();
  pc->onGatheringStateChange([gathered](rtc::PeerConnection::GatheringState state) {
    if (state == rtc::PeerConnection::GatheringState::Complete) try { gathered->set_value(); } catch (...) {}
  });
  pc->setRemoteDescription(offer);
  done.wait_for(std::chrono::seconds(2));
  const auto local = pc->localDescription();
  if (!local) { error = "no_answer"; return false; }
  answerSdp = std::string(*local);
  return true;
}

void RtcSession::restart() {
  uint32_t old, next;
  { std::lock_guard<std::mutex> lock(mutex);
    if (ended) return;
    old = generation; next = generation = generation + 1; open = true; }
  if (old) capture.endSession(old);
  capture.beginSession(next);
  capture.setFlowControl(next, 4, settings.start_bitrate, false, 0);
}

void RtcSession::send(EncodedFrame&& frame) {
  std::shared_ptr<rtc::Track> t;
  { std::lock_guard<std::mutex> lock(mutex); if (!open || frame.generation != generation) return; t = track; }
  if (t && t->isOpen()) {
    try {
      t->sendFrame(reinterpret_cast<const std::byte*>(frame.annex_b.data()), frame.annex_b.size(),
                   rtc::FrameInfo(std::chrono::duration<double, std::micro>(double(frame.pts_us))));
    } catch (const std::exception& error) { std::cerr << "RTC send failed: " << error.what() << '\n'; }
  }
  capture.acknowledge(frame.generation, frame.sequence);
}

std::deque<std::array<uint8_t, 16>> RtcSession::takeInput() {
  std::lock_guard<std::mutex> lock(mutex);
  return std::exchange(input, {});
}

bool RtcSession::closed() const {
  std::lock_guard<std::mutex> lock(mutex);
  return ended;
}
}  // namespace relay
#endif
