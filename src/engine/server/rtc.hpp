#pragma once

#include "core/capture.hpp"
#include <array>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>

struct lws_context;

namespace rtc { class PeerConnection; class Track; class DataChannel; }

namespace relay {
/** One WebRTC viewer: its own encoder, an H.264 track, and an `input` data channel carrying 16-byte input records. */
class RtcSession : public std::enable_shared_from_this<RtcSession> {
 public:
  RtcSession(CaptureSettings settings, CaptureSourceFactory factory, lws_context* context);
  ~RtcSession();
  /** Answers a complete (non-trickle) offer; blocks until ICE gathering finishes or two seconds pass. */
  bool answer(const std::string& offer, std::string& answer, std::string& error);
  /** Input records the data channel received since the last call. */
  std::deque<std::array<uint8_t, 16>> takeInput();
  bool closed() const;

 private:
  void restart();
  void send(EncodedFrame&& frame);
  CaptureSettings settings;
  lws_context* context;
  CaptureEncoder capture;
  std::shared_ptr<rtc::PeerConnection> pc;
  std::shared_ptr<rtc::Track> track;
  std::shared_ptr<rtc::DataChannel> channel;
  mutable std::mutex mutex;
  std::deque<std::array<uint8_t, 16>> input;
  uint32_t generation = 0;
  bool open = false, ended = false;
};
}  // namespace relay
