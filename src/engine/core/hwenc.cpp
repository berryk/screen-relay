#ifdef RELAY_HWENC
#include "hwenc.hpp"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/opt.h>
}
#include <chrono>
#include <climits>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <stdexcept>

namespace relay {
namespace {
struct Candidate {
  const char* name;
  AVHWDeviceType upload;
  bool dynamic_bitrate;
  const char* options;
  const char* fallback;
};
/** Platform encoders in the order "auto" tries them; options follow Sunshine's low-latency settings. */
constexpr Candidate candidates[] = {
#if defined(__APPLE__)
  {"h264_videotoolbox", AV_HWDEVICE_TYPE_NONE, false, "realtime=1:prio_speed=1:allow_sw=0", nullptr},
#else
  {"h264_nvenc", AV_HWDEVICE_TYPE_NONE, true, "preset=p1:tune=ull:rc=cbr:delay=0:zerolatency=1:forced-idr=1", nullptr},
#if defined(_WIN32)
  {"h264_qsv", AV_HWDEVICE_TYPE_NONE, true, "preset=veryfast:forced_idr=1:async_depth=1:low_delay_brc=1:low_power=1", "preset=veryfast:forced_idr=1:async_depth=1:low_delay_brc=1"},
  {"h264_amf", AV_HWDEVICE_TYPE_NONE, false, "usage=ultralowlatency:rc=cbr:forced_idr=1:latency=1:async_depth=1:frame_skipping=0:filler_data=0", "usage=lowlatency:rc=cbr:forced_idr=1:async_depth=1"},
#else
  {"h264_vaapi", AV_HWDEVICE_TYPE_VAAPI, false, "async_depth=1:rc_mode=CBR:sei=0:low_power=1", "async_depth=1:rc_mode=CBR:sei=0"},
  {"h264_qsv", AV_HWDEVICE_TYPE_NONE, true, "preset=veryfast:forced_idr=1:async_depth=1:low_delay_brc=1:low_power=1", "preset=veryfast:forced_idr=1:async_depth=1:low_delay_brc=1"},
#endif
#endif
};
std::mutex probe_mutex;
bool probed = false, disabled = false;
const Candidate* chosen = nullptr;
std::string error(int code) {
  char text[AV_ERROR_MAX_STRING_SIZE] = {};
  av_strerror(code, text, sizeof(text));
  return text;
}
}  // namespace

struct HwEncoder::Impl {
  const Candidate* candidate = nullptr;
  std::string name;
  int width = 0, height = 0;
  unsigned fps = 0;
  uint64_t bitrate = 0;
  std::chrono::steady_clock::time_point changed{};
  AVBufferRef* device = nullptr;
  AVCodecContext* context = nullptr;
  AVFrame* frame = nullptr;
  AVFrame* upload = nullptr;
  AVPacket* packet = nullptr;
  bool reopen_idr = false;
  ~Impl() { close(); av_frame_free(&frame); av_frame_free(&upload); av_packet_free(&packet); av_buffer_unref(&device); }
  void close() { avcodec_free_context(&context); }
  /** Opens the codec at the current bitrate; returns an empty string or the reason it failed. */
  std::string openCodec(const char* options) {
    close();
    const AVCodec* codec = avcodec_find_encoder_by_name(name.c_str());
    if (!codec) return "not built into libavcodec";
    context = avcodec_alloc_context3(codec);
    if (!context) return "out of memory";
    context->width = width; context->height = height;
    context->time_base = AVRational{1, 1000000};
    context->framerate = AVRational{int(fps), 1};
    context->pix_fmt = AV_PIX_FMT_NV12;
    context->max_b_frames = 0;
    context->gop_size = candidate && candidate->upload == AV_HWDEVICE_TYPE_VAAPI ? INT16_MAX : INT_MAX;
    context->keyint_min = INT_MAX;
    context->flags |= AV_CODEC_FLAG_LOW_DELAY | AV_CODEC_FLAG_CLOSED_GOP;
    context->flags2 |= AV_CODEC_FLAG2_FAST;
    context->bit_rate = context->rc_max_rate = int64_t(bitrate);
    context->rc_buffer_size = int(std::min<uint64_t>(INT_MAX, 4 * bitrate / fps));
    context->color_range = AVCOL_RANGE_MPEG;
    context->colorspace = AVCOL_SPC_BT709;
    context->color_primaries = AVCOL_PRI_BT709;
    context->color_trc = AVCOL_TRC_BT709;
    if (candidate && candidate->upload != AV_HWDEVICE_TYPE_NONE) {
      if (!device) {
        if (const int code = av_hwdevice_ctx_create(&device, candidate->upload, nullptr, nullptr, 0)) return "no device: " + error(code);
      }
      AVBufferRef* frames = av_hwframe_ctx_alloc(device);
      if (!frames) return "out of memory";
      auto* config = reinterpret_cast<AVHWFramesContext*>(frames->data);
      config->format = AV_PIX_FMT_VAAPI; config->sw_format = AV_PIX_FMT_NV12;
      config->width = width; config->height = height; config->initial_pool_size = 4;
      if (const int code = av_hwframe_ctx_init(frames)) { av_buffer_unref(&frames); return "no frame pool: " + error(code); }
      context->pix_fmt = AV_PIX_FMT_VAAPI;
      context->hw_frames_ctx = frames;
    }
    AVDictionary* dictionary = nullptr;
    if (options) av_dict_parse_string(&dictionary, options, "=", ":", 0);
    const int code = avcodec_open2(context, codec, &dictionary);
    av_dict_free(&dictionary);
    if (code < 0) { close(); return error(code); }
    return {};
  }
  /** Opens the codec with its options, then with its fallback options. */
  std::string openWithFallback() {
    std::string reason = openCodec(candidate ? candidate->options : nullptr);
    if (!reason.empty() && candidate && candidate->fallback) reason = openCodec(candidate->fallback);
    return reason;
  }
  bool allocate() {
    frame = av_frame_alloc(); packet = av_packet_alloc();
    if (!frame || !packet) return false;
    frame->format = AV_PIX_FMT_NV12; frame->width = width; frame->height = height;
    if (av_frame_get_buffer(frame, 0) < 0) return false;
    std::memset(frame->data[0], 16, size_t(frame->linesize[0]) * size_t(height));
    std::memset(frame->data[1], 128, size_t(frame->linesize[1]) * size_t(height / 2));
    return true;
  }
  bool encode(int64_t pts, bool idr, std::vector<uint8_t>& out) {
    AVFrame* input = frame;
    if (context->hw_frames_ctx) {
      if (!upload && !(upload = av_frame_alloc())) throw std::runtime_error("out of memory");
      av_frame_unref(upload);
      if (const int code = av_hwframe_get_buffer(context->hw_frames_ctx, upload, 0)) throw std::runtime_error("hardware frame: " + error(code));
      if (const int code = av_hwframe_transfer_data(upload, frame, 0)) throw std::runtime_error("upload: " + error(code));
      input = upload;
    }
    input->pts = pts;
    input->pict_type = idr ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;
    if (idr) input->flags |= AV_FRAME_FLAG_KEY; else input->flags &= ~AV_FRAME_FLAG_KEY;
    if (const int code = avcodec_send_frame(context, input)) throw std::runtime_error("send: " + error(code));
    out.clear();
    bool keyframe = false;
    while (true) {
      const int code = avcodec_receive_packet(context, packet);
      if (code == AVERROR(EAGAIN)) break;
      if (code < 0) throw std::runtime_error("receive: " + error(code));
      out.insert(out.end(), packet->data, packet->data + packet->size);
      keyframe |= (packet->flags & AV_PKT_FLAG_KEY) != 0;
      av_packet_unref(packet);
    }
    if (out.empty()) throw std::runtime_error("encoder buffered a frame");
    if (av_frame_make_writable(frame) < 0) throw std::runtime_error("frame not writable");
    return keyframe;
  }
  /** Opens this candidate and checks that a forced IDR comes back as a keyframe in Annex B. */
  std::string start() {
    if (!allocate()) return "out of memory";
    std::string reason = openWithFallback();
    if (!reason.empty()) return reason;
    std::vector<uint8_t> out;
    try {
      if (!encode(0, true, out)) return "forced IDR was not a keyframe";
    } catch (const std::exception& failure) { return failure.what(); }
    if (out.size() < 4 || out[0] || out[1] || !(out[2] == 1 || (out[2] == 0 && out[3] == 1))) return "output is not Annex B";
    return {};
  }
};

HwEncoder::HwEncoder(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
HwEncoder::~HwEncoder() = default;

std::unique_ptr<HwEncoder> HwEncoder::open(const std::string& name, int width, int height, unsigned fps, uint64_t bitrate) {
  std::lock_guard<std::mutex> lock(probe_mutex);
  av_log_set_level(AV_LOG_FATAL);
  auto attempt = [&](const Candidate* candidate, const std::string& encoder) -> std::unique_ptr<HwEncoder> {
    auto impl = std::make_unique<Impl>();
    impl->candidate = candidate; impl->name = encoder;
    impl->width = width; impl->height = height; impl->fps = fps; impl->bitrate = bitrate;
    impl->changed = std::chrono::steady_clock::now();
    const std::string reason = impl->start();
    if (!reason.empty()) {
      std::fprintf(stderr, "encoder %s unavailable: %s\n", encoder.c_str(), reason.c_str());
      return nullptr;
    }
    std::fprintf(stderr, "encoder: %s\n", encoder.c_str());
    return std::unique_ptr<HwEncoder>(new HwEncoder(std::move(impl)));
  };
  if (name != "auto") {
    const Candidate* known = nullptr;
    for (const auto& candidate : candidates) if (name == candidate.name) known = &candidate;
    return attempt(known, name);
  }
  if (disabled) return nullptr;
  if (probed) return chosen ? attempt(chosen, chosen->name) : nullptr;
  probed = true;
  for (const auto& candidate : candidates) {
    if (auto encoder = attempt(&candidate, candidate.name)) { chosen = &candidate; return encoder; }
  }
  return nullptr;
}

void HwEncoder::disable() {
  std::lock_guard<std::mutex> lock(probe_mutex);
  disabled = true;
}

uint8_t* HwEncoder::plane(int index) const { return impl_->frame->data[index]; }
int HwEncoder::stride(int index) const { return impl_->frame->linesize[index]; }
const std::string& HwEncoder::name() const { return impl_->name; }

bool HwEncoder::encode(int64_t pts_us, bool idr, uint64_t bitrate, std::vector<uint8_t>& annex_b) {
  auto& i = *impl_;
  const auto now = std::chrono::steady_clock::now();
  const bool large = bitrate * 4 > i.bitrate * 5 || bitrate * 5 < i.bitrate * 4;
  if (large && now - i.changed >= std::chrono::seconds(1)) {
    i.bitrate = bitrate; i.changed = now;
    if (i.candidate && i.candidate->dynamic_bitrate) {
      i.context->bit_rate = i.context->rc_max_rate = int64_t(bitrate);
      i.context->rc_buffer_size = int(std::min<uint64_t>(INT_MAX, 4 * bitrate / i.fps));
    } else {
      const std::string reason = i.openWithFallback();
      if (!reason.empty()) throw std::runtime_error("reopen: " + reason);
      idr = true;
    }
  }
  return i.encode(pts_us, idr, annex_b);
}
}  // namespace relay
#else
#include "hwenc.hpp"

namespace relay {
struct HwEncoder::Impl {};
HwEncoder::HwEncoder(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
HwEncoder::~HwEncoder() = default;
std::unique_ptr<HwEncoder> HwEncoder::open(const std::string&, int, int, unsigned, uint64_t) { return nullptr; }
void HwEncoder::disable() {}
uint8_t* HwEncoder::plane(int) const { return nullptr; }
int HwEncoder::stride(int) const { return 0; }
const std::string& HwEncoder::name() const { static const std::string none; return none; }
bool HwEncoder::encode(int64_t, bool, uint64_t, std::vector<uint8_t>&) { return false; }
}  // namespace relay
#endif
