#ifdef RELAY_HWENC
#include "encoder.hpp"
#include "flow.hpp"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/opt.h>
#include <libavutil/version.h>
}

#include <algorithm>
#include <chrono>
#include <climits>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <memory>
#include <string>
#include <vector>

namespace relay {
namespace {
struct Candidate {
  const char* name;
  AVHWDeviceType upload;
  AVPixelFormat rgb;
  bool dynamic_bitrate;
  const char* options;
  const char* fallback;
};

/** Platform hardware H.264 encoders probed in priority order for low-latency streaming. */
constexpr Candidate candidates[] = {
#if defined(__APPLE__)
  {"h264_videotoolbox", AV_HWDEVICE_TYPE_NONE, AV_PIX_FMT_NONE, false, "realtime=1:prio_speed=1:allow_sw=0", nullptr},
#else
  {"h264_nvenc", AV_HWDEVICE_TYPE_NONE, AV_PIX_FMT_BGR0, true, "preset=p1:tune=ull:rc=cbr:delay=0:zerolatency=1:forced-idr=1", nullptr},
#if defined(_WIN32)
  {"h264_qsv", AV_HWDEVICE_TYPE_NONE, AV_PIX_FMT_NONE, true, "preset=veryfast:forced_idr=1:async_depth=1:low_delay_brc=1:low_power=1", "preset=veryfast:forced_idr=1:async_depth=1:low_delay_brc=1"},
  {"h264_amf", AV_HWDEVICE_TYPE_NONE, AV_PIX_FMT_BGR0, false, "usage=ultralowlatency:rc=cbr:forced_idr=1:latency=1:async_depth=1:frame_skipping=0:filler_data=0", "usage=lowlatency:rc=cbr:forced_idr=1:async_depth=1"},
#else
  {"h264_vaapi", AV_HWDEVICE_TYPE_VAAPI, AV_PIX_FMT_NONE, false, "async_depth=1:rc_mode=CBR:sei=0:low_power=1", "async_depth=1:rc_mode=CBR:sei=0"},
  {"h264_qsv", AV_HWDEVICE_TYPE_NONE, AV_PIX_FMT_NONE, true, "preset=veryfast:forced_idr=1:async_depth=1:low_delay_brc=1:low_power=1", "preset=veryfast:forced_idr=1:async_depth=1:low_delay_brc=1"},
#endif
#endif
};

std::string avError(int code) {
  char text[AV_ERROR_MAX_STRING_SIZE] = {};
  av_strerror(code, text, sizeof(text));
  return text;
}

bool codecSupportsPixelFormat(const AVCodec* codec, AVPixelFormat target) {
  if (!codec || target == AV_PIX_FMT_NONE) return false;
#if LIBAVCODEC_VERSION_INT >= AV_VERSION_INT(61, 13, 100)
  const void* list = nullptr;
  int count = 0;
  if (avcodec_get_supported_config(nullptr, codec, AV_CODEC_CONFIG_PIX_FORMAT, 0, &list, &count) >= 0 && list) {
    const auto* formats = static_cast<const AVPixelFormat*>(list);
    for (int i = 0; i < count; ++i) {
      if (formats[i] == target) return true;
    }
    return false;
  }
#endif
#if LIBAVCODEC_VERSION_MAJOR < 62
  if (codec->pix_fmts) {
    for (const AVPixelFormat* p = codec->pix_fmts; *p != AV_PIX_FMT_NONE; ++p) {
      if (*p == target) return true;
    }
    return false;
  }
#endif
  return false;
}

/** Portable libavcodec H.264 encoder for NVENC, VAAPI, QSV, AMF, or an explicit codec name. */
class LibavEncoder final : public VideoEncoder {
 public:
  LibavEncoder(const Candidate* candidate, std::string codec_name, const EncoderConfig& config)
      : candidate_(candidate), name_(std::move(codec_name)), config_(config), bitrate_(config.bitrate_bps) {}

  ~LibavEncoder() override {
    closeCodec();
    av_frame_free(&frame_);
    av_frame_free(&upload_);
    av_packet_free(&packet_);
    av_buffer_unref(&device_);
  }

  bool init(std::string& error) {
    const AVCodec* codec = avcodec_find_encoder_by_name(name_.c_str());
    if (!codec) {
      error = "not built into libavcodec";
      return false;
    }
    if (config_.source_bgra && candidate_ && candidate_->rgb != AV_PIX_FMT_NONE &&
        codecSupportsPixelFormat(codec, candidate_->rgb)) {
      format_ = candidate_->rgb;
      if (allocate() && openWithFallback(error)) {
        changed_ = std::chrono::steady_clock::now();
        return true;
      }
      closeCodec();
    }
    format_ = AV_PIX_FMT_NV12;
    if (!allocate()) {
      error = "out of memory";
      return false;
    }
    if (!openWithFallback(error)) return false;
    changed_ = std::chrono::steady_clock::now();
    return true;
  }

  const std::string& name() const override { return name_; }
  bool hardware() const override { return true; }
  EncoderInput inputFormat() const override { return format_ == AV_PIX_FMT_NV12 ? EncoderInput::nv12 : EncoderInput::bgra; }
  unsigned maxInflight() const override { return 1; }
  unsigned inflight() const override { return unsigned(ready_.size()); }

  EncoderPlanes planes() override {
    if (frame_) av_frame_make_writable(frame_);
    if (!frame_) return {};
    if (format_ != AV_PIX_FMT_NV12) return {{frame_->data[0], nullptr}, {frame_->linesize[0], 0}};
    return {{frame_->data[0], frame_->data[1]}, {frame_->linesize[0], frame_->linesize[1]}};
  }

  bool submit(const EncodeRequest& req, std::string& error) override {
    using Clock = std::chrono::steady_clock;
    const auto start = Clock::now();
    bool idr = req.force_idr;
    const uint64_t rate = req.bitrate_bps ? req.bitrate_bps : bitrate_;
    const auto now = Clock::now();
    const bool large_change = rate * 4 > bitrate_ * 5 || rate * 5 < bitrate_ * 4;
    if (large_change && now - changed_ >= std::chrono::seconds(1)) {
      bitrate_ = rate;
      changed_ = now;
      if (candidate_ && candidate_->dynamic_bitrate) {
        context_->bit_rate = context_->rc_max_rate = int64_t(rate);
        context_->rc_buffer_size = int(std::min<uint64_t>(INT_MAX, 4 * rate / std::max(1u, config_.fps)));
      } else {
        std::string reopen_error;
        if (!openWithFallback(reopen_error)) {
          error = "reopen: " + reopen_error;
          return false;
        }
        idr = true;
      }
    }

    AVFrame* input = frame_;
    if (context_->hw_frames_ctx) {
      if (!upload_ && !(upload_ = av_frame_alloc())) {
        error = "out of memory";
        return false;
      }
      av_frame_unref(upload_);
      if (const int code = av_hwframe_get_buffer(context_->hw_frames_ctx, upload_, 0)) {
        error = "hardware frame: " + avError(code);
        return false;
      }
      if (const int code = av_hwframe_transfer_data(upload_, frame_, 0)) {
        error = "upload: " + avError(code);
        return false;
      }
      input = upload_;
    }

    input->pts = req.pts_us;
    input->pict_type = idr ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;
#ifdef AV_FRAME_FLAG_KEY
    if (idr) input->flags |= AV_FRAME_FLAG_KEY;
    else input->flags &= ~AV_FRAME_FLAG_KEY;
#else
    input->key_frame = idr ? 1 : 0;
#endif

    if (const int code = avcodec_send_frame(context_, input)) {
      error = "send: " + avError(code);
      return false;
    }

    EncodeResult res;
    res.pts_us = req.pts_us;
    res.tag = req.tag;
    bool keyframe = false;
    while (true) {
      const int code = avcodec_receive_packet(context_, packet_);
      if (code == AVERROR(EAGAIN)) break;
      if (code < 0) {
        res.status = EncodeStatus::failed;
        res.error = "receive: " + avError(code);
        res.encode_ns = uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - start).count());
        ready_.push_back(std::move(res));
        return true;
      }
      res.annex_b.insert(res.annex_b.end(), packet_->data, packet_->data + packet_->size);
      keyframe |= (packet_->flags & AV_PKT_FLAG_KEY) != 0;
      av_packet_unref(packet_);
    }

    res.encode_ns = uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - start).count());
    if (res.annex_b.empty()) {
      res.status = EncodeStatus::dropped;
      res.error = "encoder dropped frame";
      ready_.push_back(std::move(res));
      return true;
    }
    if (res.annex_b.size() > FlowControl::max_bytes) {
      res.status = EncodeStatus::failed;
      res.error = "encoded access unit too large";
      res.annex_b.clear();
      ready_.push_back(std::move(res));
      return true;
    }
    res.status = EncodeStatus::encoded;
    res.keyframe = keyframe;
    res.converged = req.refinement && res.annex_b.size() <= rate / (4ull * std::max(1u, config_.fps));
    ready_.push_back(std::move(res));
    return true;
  }

  bool poll(std::vector<EncodeResult>& out, bool) override {
    if (ready_.empty()) return false;
    while (!ready_.empty()) {
      out.push_back(std::move(ready_.front()));
      ready_.pop_front();
    }
    return true;
  }

  void flush(std::vector<EncodeResult>& out) override { poll(out, false); }

  bool reset(std::string& error) override {
    ready_.clear();
    return openWithFallback(error);
  }

 private:
  void closeCodec() { avcodec_free_context(&context_); }

  bool openCodec(const char* options, std::string& error) {
    closeCodec();
    const AVCodec* codec = avcodec_find_encoder_by_name(name_.c_str());
    if (!codec) {
      error = "not built into libavcodec";
      return false;
    }
    context_ = avcodec_alloc_context3(codec);
    if (!context_) {
      error = "out of memory";
      return false;
    }
    context_->width = config_.width;
    context_->height = config_.height;
    context_->time_base = AVRational{1, 1000000};
    context_->framerate = AVRational{int(config_.fps), 1};
    context_->pix_fmt = format_;
    context_->max_b_frames = 0;
    context_->gop_size = candidate_ && candidate_->upload == AV_HWDEVICE_TYPE_VAAPI ? INT16_MAX : INT_MAX;
    context_->keyint_min = INT_MAX;
    context_->flags |= AV_CODEC_FLAG_LOW_DELAY | AV_CODEC_FLAG_CLOSED_GOP;
    context_->flags2 |= AV_CODEC_FLAG2_FAST;
    context_->bit_rate = context_->rc_max_rate = int64_t(bitrate_);
    context_->rc_buffer_size = int(std::min<uint64_t>(INT_MAX, 4 * bitrate_ / std::max(1u, config_.fps)));
    context_->color_range = AVCOL_RANGE_MPEG;
    context_->colorspace = AVCOL_SPC_BT709;
    context_->color_primaries = AVCOL_PRI_BT709;
    context_->color_trc = AVCOL_TRC_BT709;

    if (candidate_ && candidate_->upload != AV_HWDEVICE_TYPE_NONE) {
      if (!device_) {
        if (const int code = av_hwdevice_ctx_create(&device_, candidate_->upload, nullptr, nullptr, 0)) {
          error = "no device: " + avError(code);
          closeCodec();
          return false;
        }
      }
      AVBufferRef* frames = av_hwframe_ctx_alloc(device_);
      if (!frames) {
        error = "out of memory";
        closeCodec();
        return false;
      }
      auto* cfg = reinterpret_cast<AVHWFramesContext*>(frames->data);
      cfg->format = AV_PIX_FMT_VAAPI;
      cfg->sw_format = AV_PIX_FMT_NV12;
      cfg->width = config_.width;
      cfg->height = config_.height;
      cfg->initial_pool_size = 4;
      if (const int code = av_hwframe_ctx_init(frames)) {
        av_buffer_unref(&frames);
        error = "no frame pool: " + avError(code);
        closeCodec();
        return false;
      }
      context_->pix_fmt = AV_PIX_FMT_VAAPI;
      context_->hw_frames_ctx = frames;
    }

    AVDictionary* dict = nullptr;
    if (options) av_dict_parse_string(&dict, options, "=", ":", 0);
    const int code = avcodec_open2(context_, codec, &dict);
    av_dict_free(&dict);
    if (code < 0) {
      error = avError(code);
      closeCodec();
      return false;
    }
    return true;
  }

  bool openWithFallback(std::string& error) {
    if (openCodec(candidate_ ? candidate_->options : nullptr, error)) return true;
    if (candidate_ && candidate_->fallback) {
      return openCodec(candidate_->fallback, error);
    }
    return false;
  }

  bool allocate() {
    av_frame_free(&frame_);
    if (!packet_) packet_ = av_packet_alloc();
    frame_ = av_frame_alloc();
    if (!frame_ || !packet_) return false;
    frame_->format = format_;
    frame_->width = config_.width;
    frame_->height = config_.height;
    if (av_frame_get_buffer(frame_, 0) < 0) return false;
    if (format_ != AV_PIX_FMT_NV12) {
      std::memset(frame_->data[0], 0, size_t(frame_->linesize[0]) * size_t(config_.height));
      return true;
    }
    std::memset(frame_->data[0], 16, size_t(frame_->linesize[0]) * size_t(config_.height));
    std::memset(frame_->data[1], 128, size_t(frame_->linesize[1]) * size_t(config_.height / 2));
    return true;
  }

  const Candidate* candidate_ = nullptr;
  std::string name_;
  EncoderConfig config_;
  uint64_t bitrate_ = 0;
  AVPixelFormat format_ = AV_PIX_FMT_NV12;
  std::chrono::steady_clock::time_point changed_{};
  AVBufferRef* device_ = nullptr;
  AVCodecContext* context_ = nullptr;
  AVFrame* frame_ = nullptr;
  AVFrame* upload_ = nullptr;
  AVPacket* packet_ = nullptr;
  std::deque<EncodeResult> ready_;
};
}  // namespace

std::unique_ptr<VideoEncoder> createLibavEncoder(const EncoderConfig& config, std::string& error) {
  av_log_set_level(AV_LOG_FATAL);
  if (config.preference != "auto") {
    const Candidate* known = nullptr;
    for (const auto& candidate : candidates) {
      if (config.preference == candidate.name) known = &candidate;
    }
    auto enc = std::make_unique<LibavEncoder>(known, config.preference, config);
    if (enc->init(error)) return enc;
    return nullptr;
  }
  for (const auto& candidate : candidates) {
    std::string reason;
    auto enc = std::make_unique<LibavEncoder>(&candidate, candidate.name, config);
    if (enc->init(reason)) return enc;
    error = std::string(candidate.name) + ": " + reason;
  }
  return nullptr;
}

}  // namespace relay
#endif
