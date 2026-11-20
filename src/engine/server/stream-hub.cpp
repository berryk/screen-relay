#include "stream-hub.hpp"
#include <algorithm>
#include <chrono>
#include <utility>

namespace relay {
namespace {
using Clock = std::chrono::steady_clock;

uint64_t nowUs() {
  return uint64_t(std::chrono::duration_cast<std::chrono::microseconds>(Clock::now().time_since_epoch()).count());
}
}  // namespace

const char* hubStateName(HubState state) {
  switch (state) {
    case HubState::stopped: return "stopped";
    case HubState::idle: return "idle";
    case HubState::streaming: return "streaming";
    case HubState::failed: return "failed";
  }
  return "unknown";
}

const char* viewerStateName(ViewerState state) {
  switch (state) {
    case ViewerState::disconnected: return "disconnected";
    case ViewerState::awaiting_idr: return "awaiting_idr";
    case ViewerState::streaming: return "streaming";
    case ViewerState::closing: return "closing";
  }
  return "unknown";
}

StreamHub::StreamHub(CaptureSettings settings, CaptureSourceFactory factory, WakeCallback wake,
                     EncoderFactories encoder_factories)
    : settings_(std::move(settings)), wake_(std::move(wake)),
      capture_([this](std::shared_ptr<const EncodedFrame> frame) { return onFrame(std::move(frame)); },
               settings_, std::move(factory),
               [this](uint32_t gen, CursorImage&& cursor) { onCursor(gen, std::move(cursor)); },
               std::move(encoder_factories)) {}

StreamHub::~StreamHub() { stop(); }

bool StreamHub::start(std::string& error) {
  if (!capture_.start(error)) {
    std::lock_guard<std::mutex> lock(mutex_);
    state_ = HubState::failed;
    return false;
  }
  std::lock_guard<std::mutex> lock(mutex_);
  state_ = HubState::idle;
  return true;
}

void StreamHub::stop() {
  uint32_t old_gen = 0;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    old_gen = encoder_generation_;
    encoder_generation_ = 0;
    for (auto& sub : subscribers_) {
      sub->state = ViewerState::disconnected;
      sub->pending.clear();
      sub->pending_cursor.reset();
      sub->flow.reset();
      sub->wire_to_encoder_seq.clear();
    }
    subscribers_.clear();
    state_ = HubState::stopped;
  }
  if (old_gen) capture_.endSession(old_gen);
  capture_.stop();
}

uint64_t StreamHub::driverIdLocked() const {
  uint64_t fallback_ws = 0;
  uint64_t fallback_rtc = 0;
  for (const auto& sub : subscribers_) {
    if (!sub || sub->state == ViewerState::disconnected || sub->state == ViewerState::closing || sub->failed) continue;
    if (sub->role == SubscriberRole::controller) return sub->id;
    if (sub->role == SubscriberRole::watch && !fallback_ws) fallback_ws = sub->id;
    if (sub->role == SubscriberRole::rtc && !fallback_rtc) fallback_rtc = sub->id;
  }
  return fallback_ws ? fallback_ws : fallback_rtc;
}

void StreamHub::pushDriverFlowLocked(uint64_t now_us, uint32_t& enc_gen, unsigned& window,
                                     uint64_t& bitrate, bool& paused, uint64_t& admit_until, bool& should_push) const {
  should_push = false;
  if (state_ != HubState::streaming || !encoder_generation_) return;
  const uint64_t driver_id = driverIdLocked();
  if (!driver_id) return;
  for (const auto& sub : subscribers_) {
    if (sub->id != driver_id) continue;
    enc_gen = encoder_generation_;
    if (sub->role == SubscriberRole::rtc) {
      window = 4;
      bitrate = settings_.start_bitrate;
      paused = false;
      admit_until = 0;
    } else {
      window = sub->flow.window;
      bitrate = sub->flow.frameBitrate();
      paused = sub->flow.paused(now_us);
      const bool inflight = !sub->flow.frames.empty();
      admit_until = inflight && sub->flow.transport_available
          ? sub->flow.frames.front().captured_us + sub->flow.transportAgeLimitUs()
          : 0;
    }
    should_push = true;
    return;
  }
}

std::shared_ptr<StreamHub::Subscriber> StreamHub::attach(SubscriberRole role, uint32_t viewer_generation,
                                                         bool clipboard_notices, RtcSink rtc_sink) {
  auto sub = std::make_shared<Subscriber>();
  sub->role = role;
  sub->state = ViewerState::awaiting_idr;
  sub->generation = viewer_generation;
  sub->clipboard_notices = clipboard_notices;
  sub->rtc_sink = std::move(rtc_sink);
  sub->keyframe_requested_us = nowUs();
  sub->flow.configure(settings_.min_bitrate, settings_.start_bitrate, settings_.max_bitrate, settings_.fps);

  bool start_session = false;
  bool request_idr = false;
  uint32_t enc_gen = 0;
  unsigned window = 1;
  uint64_t bitrate = settings_.start_bitrate, admit_until = 0;
  bool paused = false, push_flow = false;

  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ == HubState::stopped || state_ == HubState::failed) return nullptr;
    sub->id = ++next_subscriber_id_;
    subscribers_.push_back(sub);
    if (state_ == HubState::idle) {
      state_ = HubState::streaming;
      enc_gen = ++encoder_generation_;
      last_encoder_seq_ = 0;
      start_session = true;
    } else {
      enc_gen = encoder_generation_;
      request_idr = true;
    }
    pushDriverFlowLocked(nowUs(), enc_gen, window, bitrate, paused, admit_until, push_flow);
  }

  if (start_session) {
    capture_.beginSession(enc_gen);
  } else if (request_idr) {
    capture_.requestKeyframe();
  }
  if (push_flow) {
    capture_.setFlowControl(enc_gen, window, bitrate, paused, admit_until);
  }
  return sub;
}

void StreamHub::detach(uint64_t subscriber_id) {
  bool end_session = false;
  uint32_t old_enc_gen = 0;
  uint32_t ack_enc_gen = 0, ack_enc_seq = 0;
  unsigned window = 1;
  uint64_t bitrate = settings_.start_bitrate, admit_until = 0;
  bool paused = false, push_flow = false;

  {
    std::lock_guard<std::mutex> lock(mutex_);
    const uint64_t prev_driver = driverIdLocked();
    for (auto it = subscribers_.begin(); it != subscribers_.end(); ++it) {
      if ((*it)->id != subscriber_id) continue;
      (*it)->state = ViewerState::disconnected;
      (*it)->pending.clear();
      (*it)->pending_cursor.reset();
      (*it)->flow.reset();
      (*it)->wire_to_encoder_seq.clear();
      (*it)->rtc_sink = nullptr;
      subscribers_.erase(it);
      break;
    }
    if (subscribers_.empty()) {
      if (state_ == HubState::streaming) {
        old_enc_gen = encoder_generation_;
        state_ = HubState::idle;
        end_session = true;
      }
    } else {
      const uint64_t next_driver = driverIdLocked();
      if (next_driver != prev_driver && last_encoder_seq_ > 0) {
        ack_enc_gen = encoder_generation_;
        ack_enc_seq = last_encoder_seq_;
      }
      pushDriverFlowLocked(nowUs(), old_enc_gen, window, bitrate, paused, admit_until, push_flow);
    }
  }

  if (end_session && old_enc_gen) {
    capture_.endSession(old_enc_gen);
    return;
  }
  if (ack_enc_gen && ack_enc_seq) {
    capture_.acknowledge(ack_enc_gen, ack_enc_seq);
  }
  if (push_flow) {
    capture_.setFlowControl(old_enc_gen, window, bitrate, paused, admit_until);
  }
}

bool StreamHub::onFrame(std::shared_ptr<const EncodedFrame> frame) {
  bool request_idr = false;
  bool ack_now = false;
  uint32_t ack_gen = 0, ack_seq = 0;
  std::vector<std::pair<RtcSink, std::shared_ptr<const EncodedFrame>>> rtc_deliveries;
  bool notify_ws = false;

  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ != HubState::streaming || frame->generation != encoder_generation_) return false;
    last_encoder_seq_ = frame->sequence;
    const uint64_t now = nowUs();
    const uint64_t driver_id = driverIdLocked();

    for (auto& sub : subscribers_) {
      if (!sub || sub->state == ViewerState::disconnected || sub->state == ViewerState::closing || sub->failed) continue;
      if (sub->role == SubscriberRole::rtc) {
        if (sub->state == ViewerState::awaiting_idr) {
          if (!frame->keyframe) continue;
          sub->state = ViewerState::streaming;
        }
        if (sub->rtc_sink) rtc_deliveries.emplace_back(sub->rtc_sink, frame);
        if (sub->id == driver_id) {
          ack_now = true;
          ack_gen = frame->generation;
          ack_seq = frame->sequence;
        }
        continue;
      }

      if (sub->state == ViewerState::awaiting_idr && !frame->keyframe) continue;
      const uint32_t next_seq = sub->wire_sequence + 1;
      if (!sub->flow.enqueue(next_seq, frame->annex_b.size(), frame->pts_us, now)) {
        if (sub->id == driver_id && sub->role == SubscriberRole::controller) {
          sub->failed = true;
          sub->state = ViewerState::closing;
          notify_ws = true;
        } else {
          sub->state = ViewerState::awaiting_idr;
          if (now - std::min(now, sub->keyframe_requested_us) >= 1000000) {
            sub->keyframe_requested_us = now;
            request_idr = true;
          }
        }
        continue;
      }

      sub->wire_sequence = next_seq;
      sub->state = ViewerState::streaming;
      sub->wire_to_encoder_seq.emplace_back(next_seq, frame->sequence);
      sub->pending.push_back(ViewerPacket{next_seq, frame});
      notify_ws = true;
    }
  }

  for (auto& delivery : rtc_deliveries) {
    delivery.first(delivery.second);
  }
  if (ack_now) capture_.acknowledge(ack_gen, ack_seq);
  if (request_idr) capture_.requestKeyframe();
  if (notify_ws && wake_) wake_();
  return true;
}

void StreamHub::onCursor(uint32_t encoder_gen, CursorImage&& cursor) {
  bool notify = false;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ != HubState::streaming || encoder_gen != encoder_generation_) return;
    for (auto& sub : subscribers_) {
      if (!sub || sub->role == SubscriberRole::rtc || sub->state == ViewerState::disconnected || sub->state == ViewerState::closing) continue;
      sub->pending_cursor = cursor;
      notify = true;
    }
  }
  if (notify && wake_) wake_();
}

void StreamHub::updateFlow(const std::shared_ptr<Subscriber>& sub, uint64_t now_us,
                           const std::optional<FlowControl::TransportSample>& sample,
                           unsigned& out_window, uint64_t& out_deadline_us, uint32_t& out_lowat) {
  uint32_t enc_gen = 0;
  unsigned window = 1;
  uint64_t bitrate = settings_.start_bitrate, admit_until = 0;
  bool paused = false, push_flow = false;

  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!sub || sub->state == ViewerState::disconnected) {
      out_window = 1;
      out_deadline_us = 0;
      out_lowat = 0;
      return;
    }
    if (sample) sub->flow.sampleTransport(*sample, now_us);
    else sub->flow.clearTransport();
    sub->flow.update(now_us);
    out_window = sub->flow.window;
    out_lowat = sub->flow.notsentLowat();
    out_deadline_us = sub->flow.serviceDeadlineUs(now_us, sub->flow_timer_due_us);
    if (sub->id == driverIdLocked()) {
      pushDriverFlowLocked(now_us, enc_gen, window, bitrate, paused, admit_until, push_flow);
    }
  }

  if (push_flow) {
    capture_.setFlowControl(enc_gen, window, bitrate, paused, admit_until);
  }
}

bool StreamHub::acknowledge(const std::shared_ptr<Subscriber>& sub, uint32_t viewer_generation, uint32_t sequence,
                            uint64_t now_us, uint64_t wait_us) {
  bool accepted = false;
  uint32_t ack_enc_gen = 0, ack_enc_seq = 0;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!sub || sub->generation != viewer_generation || !sequence) return false;
    accepted = sub->flow.ack(sequence, now_us, wait_us);
    if (accepted) {
      uint32_t mapped = 0;
      while (!sub->wire_to_encoder_seq.empty() && sub->wire_to_encoder_seq.front().first <= sequence) {
        mapped = sub->wire_to_encoder_seq.front().second;
        sub->wire_to_encoder_seq.pop_front();
      }
      if (sub->id == driverIdLocked() && mapped > 0) {
        ack_enc_gen = encoder_generation_;
        ack_enc_seq = mapped;
      }
    }
  }
  if (ack_enc_gen && ack_enc_seq) {
    capture_.acknowledge(ack_enc_gen, ack_enc_seq);
  }
  return accepted;
}

void StreamHub::requestKeyframe() {
  capture_.requestKeyframe();
}

bool StreamHub::popOutbound(const std::shared_ptr<Subscriber>& sub, std::optional<ViewerPacket>& packet,
                            std::optional<CursorImage>& cursor, bool& failed, bool& more_pending) {
  packet.reset();
  cursor.reset();
  failed = false;
  more_pending = false;
  std::lock_guard<std::mutex> lock(mutex_);
  if (!sub || sub->state == ViewerState::disconnected) {
    failed = true;
    return false;
  }
  if (sub->failed) {
    failed = true;
    return false;
  }
  if (sub->last_sent_sequence && sub->pending_cursor && (!sub->last_write_cursor || sub->pending.empty())) {
    cursor = std::move(sub->pending_cursor);
    sub->pending_cursor.reset();
    sub->last_write_cursor = true;
    more_pending = !sub->pending.empty() || sub->pending_cursor.has_value();
    return true;
  }
  if (sub->pending.empty()) return false;
  packet = std::move(sub->pending.front());
  sub->pending.pop_front();
  sub->last_write_cursor = false;
  more_pending = !sub->pending.empty() || sub->pending_cursor.has_value();
  return true;
}

bool StreamHub::markSent(const std::shared_ptr<Subscriber>& sub, uint32_t sequence, uint64_t now_us) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!sub || sub->state == ViewerState::disconnected) return false;
  return sub->flow.sent(sequence, now_us);
}

bool StreamHub::timedOut(const std::shared_ptr<Subscriber>& sub, uint64_t now_us) const {
  if (!capture_.error().empty()) return true;
  std::lock_guard<std::mutex> lock(mutex_);
  if (!sub) return true;
  return sub->failed || sub->flow.timedOut(now_us);
}

std::string StreamHub::metricsFor(const std::shared_ptr<Subscriber>& sub, uint64_t now_us) const {
  std::lock_guard<std::mutex> lock(mutex_);
  const FlowControl* f = sub ? &sub->flow : nullptr;
  FlowControl idle;
  if (!f) {
    idle.configure(settings_.min_bitrate, settings_.start_bitrate, settings_.max_bitrate, settings_.fps);
    f = &idle;
  }
  return ",\"inflight_frames\":" + std::to_string(f->frames.size()) +
      ",\"inflight_bytes\":" + std::to_string(f->bytes) +
      ",\"window_frames\":" + std::to_string(f->window) +
      ",\"target_bitrate_bps\":" + std::to_string(f->target_bitrate) +
      ",\"min_rtt_ms\":" + std::to_string(f->transport.min_rtt_us / 1000.0) +
      ",\"delivery_rate_bps\":" + std::to_string(f->delivery_rate_bps) +
      ",\"notsent_bytes\":" + std::to_string(f->transport.notsent_bytes) +
      ",\"sender_queue_ms\":" + std::to_string(f->senderQueueUs() / 1000.0) +
      ",\"retrans\":" + std::to_string(f->transport.total_retrans) +
      ",\"ack_rtt_ms\":" + std::to_string(f->ack_rtt_us / 1000.0) +
      ",\"oldest_frame_ms\":" + std::to_string(f->oldestAge(now_us) / 1000.0) +
      ",\"frames_acked\":" + std::to_string(f->acknowledged) +
      ",\"frames_encoded\":" + std::to_string(f->encoded) +
      ",\"observed_busy_goodput_bps\":" + std::to_string(f->goodput_bps) +
      ",\"max_inflight_frames\":" + std::to_string(f->frameLimit()) +
      ",\"max_inflight_bytes\":" + std::to_string(FlowControl::max_bytes) +
      ",\"max_frame_bytes\":" + std::to_string(FlowControl::max_bytes) +
      ",\"admission_age_ms\":" + std::to_string(f->admissionAgeUs() / 1000.0) +
      ",\"no_ack_timeout_ms\":" + std::to_string(FlowControl::timeout_us / 1000) +
      ",\"max_frame_age_ms\":" + std::to_string(FlowControl::timeout_us / 1000);
}

std::string StreamHub::primaryMetrics(uint64_t now_us) const {
  std::shared_ptr<Subscriber> driver;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const uint64_t id = driverIdLocked();
    for (const auto& sub : subscribers_) {
      if (sub && sub->id == id) { driver = sub; break; }
    }
  }
  return metricsFor(driver, now_us);
}

HubState StreamHub::state() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return state_;
}

size_t StreamHub::subscriberCount() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return subscribers_.size();
}

CaptureStats StreamHub::stats() const { return capture_.stats(); }

std::string StreamHub::error() const { return capture_.error(); }

std::string StreamHub::profileLevelId() const { return capture_.stats().profile_level_id; }

}  // namespace relay
