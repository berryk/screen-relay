#include "core/capture.hpp"
#include "core/wait.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <sys/resource.h>
#endif

using Clock = std::chrono::steady_clock;

struct Options {
  std::string encoder = "auto";
  int width = 1920;
  int height = 1080;
  unsigned fps = 60;
  uint64_t bitrate = 8000000;
  double warmup = 1.0;
  double seconds = 5.0;
};

uint64_t parseInteger(const std::string& value, const std::string& option) {
  uint64_t number = 0;
  const auto result = std::from_chars(value.data(), value.data() + value.size(), number);
  if (value.empty() || result.ec != std::errc{} || result.ptr != value.data() + value.size())
    throw std::runtime_error("invalid value for " + option);
  return number;
}

double parseSeconds(const std::string& value, const std::string& option) {
  size_t end = 0;
  double number = 0;
  try {
    number = std::stod(value, &end);
  } catch (const std::exception&) {
    throw std::runtime_error("invalid value for " + option);
  }
  const double limit = std::chrono::duration<double>(Clock::duration::max()).count() / 4;
  if (end != value.size() || !std::isfinite(number) || number < 0 || number > limit)
    throw std::runtime_error("invalid value for " + option);
  return number;
}

Options parseOptions(int argc, char** argv) {
  Options options;
  for (int i = 1; i < argc; ++i) {
    const std::string option = argv[i];
    if (i + 1 >= argc) throw std::runtime_error("missing value for " + option);
    const std::string value = argv[++i];
    if (option == "--encoder") {
      if (value.empty()) throw std::runtime_error("invalid value for " + option);
      options.encoder = value;
    } else if (option == "--size") {
      const size_t separator = value.find('x');
      if (separator == std::string::npos) throw std::runtime_error("invalid value for " + option);
      const uint64_t width = parseInteger(value.substr(0, separator), option);
      const uint64_t height = parseInteger(value.substr(separator + 1), option);
      if (width > uint64_t(std::numeric_limits<int>::max()) ||
          height > uint64_t(std::numeric_limits<int>::max()))
        throw std::runtime_error("invalid value for " + option);
      options.width = int(width);
      options.height = int(height);
    } else if (option == "--fps") {
      const uint64_t fps = parseInteger(value, option);
      if (fps < 1 || fps > 1000) throw std::runtime_error("invalid value for " + option);
      options.fps = unsigned(fps);
    } else if (option == "--bitrate") {
      const uint64_t bitrate = parseInteger(value, option);
      if (!bitrate || bitrate > uint64_t(std::numeric_limits<int>::max()) * 1000 / 8)
        throw std::runtime_error("invalid value for " + option);
      options.bitrate = bitrate;
    } else if (option == "--warmup") {
      options.warmup = parseSeconds(value, option);
    } else if (option == "--seconds") {
      options.seconds = parseSeconds(value, option);
      if (options.seconds == 0) throw std::runtime_error("invalid value for " + option);
    } else {
      throw std::runtime_error("unknown option " + option);
    }
  }
  relay::requireSurfaceSize(options.width, options.height);
  return options;
}

using Ring = std::array<std::vector<uint8_t>, 16>;

uint32_t pixelHash(uint32_t x, uint32_t y) {
  uint32_t value = x * 0x9e3779b9u ^ y * 0x85ebca6bu;
  value ^= value >> 16;
  value *= 0x7feb352du;
  value ^= value >> 15;
  value *= 0x846ca68bu;
  return value ^ (value >> 16);
}

Ring renderRing(int width, int height) {
  Ring ring;
  for (size_t frame = 0; frame < ring.size(); ++frame) {
    auto& pixels = ring[frame];
    pixels.resize(size_t(width) * size_t(height) * 4);
    for (int y = 0; y < height; ++y) {
      for (int x = 0; x < width; ++x) {
        const uint32_t hash = pixelHash(uint32_t(x), uint32_t(y));
        const int scroll_x = (x + int(frame) * 17) % width;
        const int scroll_y = (y + int(frame) * 11) % height;
        const bool checker = ((scroll_x / 32 + scroll_y / 32) & 1) != 0;
        const uint8_t noise = uint8_t((hash ^ (uint32_t(frame) * 0x9e3779b9u)) & 15);
        const size_t offset = (size_t(y) * size_t(width) + size_t(x)) * 4;
        pixels[offset] = uint8_t(hash) ^ uint8_t(frame * 13);
        pixels[offset + 1] = uint8_t(scroll_y * 255 / height) ^ uint8_t(checker ? 96 : 0) ^ noise;
        pixels[offset + 2] = uint8_t(scroll_x * 255 / width) ^ uint8_t(checker ? 64 : 0) ^ noise;
        pixels[offset + 3] = 255;
      }
    }
  }
  return ring;
}

class RingSource final : public relay::CaptureSource {
 public:
  RingSource(const Ring& ring, int width, int height) : ring_(ring), width_(width), height_(height) {
    if (!wake_.valid()) throw std::runtime_error("creating damage wake handle failed");
  }

  relay::WaitHandle fd() const override { return wake_.handle(); }
  std::pair<int, int> dimensions() const override { return {width_, height_}; }
  bool drainDamage() override {
    wake_.consume();
    return true;
  }
  relay::PixelFormat pixelFormat() const override { return relay::PixelFormat::BGRA; }
  relay::FrameView capture() override {
    const auto& pixels = ring_[next_];
    next_ = (next_ + 1) % ring_.size();
    wake_.signal();
    return {pixels.data(), width_ * 4, width_, height_, relay::PixelFormat::BGRA};
  }

 private:
  const Ring& ring_;
  int width_;
  int height_;
  size_t next_ = 0;
  relay::Wake wake_;
};

double processCpuSeconds() {
#ifdef _WIN32
  FILETIME creation, exit, kernel, user;
  if (!GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user))
    throw std::runtime_error("GetProcessTimes failed");
  const auto ticks = [](const FILETIME& time) {
    return (uint64_t(time.dwHighDateTime) << 32) | uint64_t(time.dwLowDateTime);
  };
  return double(ticks(kernel) + ticks(user)) / 10000000.0;
#else
  rusage usage{};
  if (getrusage(RUSAGE_SELF, &usage) != 0) throw std::runtime_error("getrusage failed");
  return double(usage.ru_utime.tv_sec) + double(usage.ru_stime.tv_sec) +
         double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000000.0;
#endif
}

struct Measurements {
  std::mutex mutex;
  bool active = false;
  bool bad_keyframe = false;
  uint64_t frames = 0;
  uint64_t bytes = 0;
  uint64_t keyframes = 0;
  Clock::time_point previous{};
  std::vector<double> intervals;
};

struct Result {
  Options options;
  relay::CaptureStats start;
  relay::CaptureStats end;
  double wall_s = 0;
  double cpu_cores = 0;
  uint64_t frames = 0;
  uint64_t bytes = 0;
  uint64_t keyframes = 0;
  std::vector<double> intervals;
  std::string fatal;
};

Result benchmark(const Options& options) {
  Result result;
  result.options = options;
  const Ring ring = renderRing(options.width, options.height);
  Measurements measurements;
  relay::CaptureSettings settings;
  settings.encoder = options.encoder;
  settings.fps = options.fps;
  settings.min_bitrate = options.bitrate;
  settings.start_bitrate = options.bitrate;
  settings.max_bitrate = options.bitrate;
  relay::CaptureEncoder* encoder_ptr = nullptr;
  relay::CaptureEncoder encoder(
      [&](std::shared_ptr<const relay::EncodedFrame> frame) {
        encoder_ptr->acknowledge(frame->generation, frame->sequence);
        const auto now = Clock::now();
        const bool valid_keyframe = !frame->keyframe ||
            (relay::hasNalUnit(frame->annex_b, 5) && relay::hasNalUnit(frame->annex_b, 7) &&
             relay::hasNalUnit(frame->annex_b, 8));
        std::lock_guard<std::mutex> lock(measurements.mutex);
        if (!valid_keyframe) measurements.bad_keyframe = true;
        if (measurements.active) {
          if (measurements.frames)
            measurements.intervals.push_back(std::chrono::duration<double, std::milli>(now - measurements.previous).count());
          measurements.previous = now;
          ++measurements.frames;
          measurements.bytes += frame->annex_b.size();
          if (frame->keyframe) ++measurements.keyframes;
        }
        return true;
      },
      settings, [&] { return std::make_unique<RingSource>(ring, options.width, options.height); });
  encoder_ptr = &encoder;
  std::string error;
  if (!encoder.start(error)) {
    result.fatal = error.empty() ? "encoder startup failed" : error;
    return result;
  }
  encoder.beginSession(1);
  encoder.setFlowControl(1, 8, options.bitrate, false, 0);
  std::this_thread::sleep_for(std::chrono::duration<double>(options.warmup));
  result.start = encoder.stats();
  const double cpu_start = processCpuSeconds();
  Clock::time_point start;
  {
    std::lock_guard<std::mutex> lock(measurements.mutex);
    start = Clock::now();
    measurements.active = true;
  }
  std::this_thread::sleep_until(start + std::chrono::duration_cast<Clock::duration>(
                                           std::chrono::duration<double>(options.seconds)));
  Clock::time_point end;
  {
    std::lock_guard<std::mutex> lock(measurements.mutex);
    end = Clock::now();
    measurements.active = false;
    result.frames = measurements.frames;
    result.bytes = measurements.bytes;
    result.keyframes = measurements.keyframes;
    result.intervals = std::move(measurements.intervals);
  }
  const double cpu_end = processCpuSeconds();
  result.wall_s = std::chrono::duration<double>(end - start).count();
  result.cpu_cores = (cpu_end - cpu_start) / result.wall_s;
  result.end = encoder.stats();
  encoder.stop();
  if (measurements.bad_keyframe) result.fatal = "keyframe missing Annex B IDR, SPS, or PPS";
  error = encoder.error();
  if (!error.empty()) result.fatal = error;
  if (result.frames == 0 && result.fatal.empty()) result.fatal = "no frames published during measurement";
  return result;
}

std::string jsonString(const std::string& value) {
  static constexpr char hex[] = "0123456789abcdef";
  std::string output = "\"";
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') {
      output += '\\';
      output += char(c);
    } else if (c < 0x20) {
      output += "\\u00";
      output += hex[c >> 4];
      output += hex[c & 15];
    } else {
      output += char(c);
    }
  }
  return output + '"';
}

double percentile(const std::vector<double>& sorted, double fraction) {
  if (sorted.empty()) return 0;
  const size_t raw = size_t(std::ceil(fraction * double(sorted.size())));
  const size_t index = raw ? std::min(sorted.size() - 1, raw - 1) : 0;
  return sorted[index];
}

void printResult(Result& result) {
  std::sort(result.intervals.begin(), result.intervals.end());
  const auto delta = [](uint64_t end, uint64_t start) { return end >= start ? end - start : 0; };
  const uint64_t captures = delta(result.end.captures, result.start.captures);
  const uint64_t encoded = delta(result.end.encoded, result.start.encoded);
  const uint64_t dropped = delta(result.end.dropped_frames, result.start.dropped_frames);
  const auto averageMs = [](uint64_t nanos, uint64_t count) {
    return count ? double(nanos) / double(count) / 1000000.0 : 0.0;
  };
  std::cout << std::fixed << std::setprecision(6)
            << "{\"encoder_req\":" << jsonString(result.options.encoder)
            << ",\"encoder_start\":" << jsonString(result.start.encoder)
            << ",\"encoder_end\":" << jsonString(result.end.encoder)
            << ",\"hardware\":" << (result.end.hardware_encoder ? "true" : "false")
            << ",\"encoder_state\":" << jsonString(result.end.encoder_state)
            << ",\"size\":" << jsonString(std::to_string(result.options.width) + "x" + std::to_string(result.options.height))
            << ",\"target_fps\":" << result.options.fps
            << ",\"bitrate_mbps\":" << double(result.options.bitrate) / 1000000.0
            << ",\"wall_s\":" << result.wall_s
            << ",\"frames\":" << result.frames
            << ",\"fps\":" << (result.wall_s > 0 ? double(result.frames) / result.wall_s : 0.0)
            << ",\"mbps\":" << (result.wall_s > 0 ? double(result.bytes) * 8 / result.wall_s / 1000000.0 : 0.0)
            << ",\"kb_frame\":" << (result.frames ? double(result.bytes) / double(result.frames) / 1024.0 : 0.0)
            << ",\"keyframes\":" << result.keyframes
            << ",\"dropped_frames\":" << dropped
            << ",\"fallback_count\":" << delta(result.end.fallback_count, result.start.fallback_count)
            << ",\"cpu_cores\":" << result.cpu_cores
            << ",\"cap_ms\":" << averageMs(delta(result.end.capture_ns, result.start.capture_ns), captures)
            << ",\"cvt_ms\":" << averageMs(delta(result.end.convert_ns, result.start.convert_ns), captures)
            << ",\"enc_ms\":" << averageMs(delta(result.end.encode_ns, result.start.encode_ns), encoded + dropped)
            << ",\"ivl_p50_ms\":" << percentile(result.intervals, 0.50)
            << ",\"ivl_p95_ms\":" << percentile(result.intervals, 0.95)
            << ",\"ivl_max_ms\":" << (result.intervals.empty() ? 0.0 : result.intervals.back())
            << ",\"fatal\":" << (result.fatal.empty() ? "null" : jsonString(result.fatal)) << "}\n";
}

int main(int argc, char** argv) {
  Result result;
  try {
    result.options = parseOptions(argc, argv);
    result = benchmark(result.options);
  } catch (const std::exception& error) {
    result.fatal = error.what();
  }
  printResult(result);
  return result.fatal.empty() ? 0 : 1;
}
