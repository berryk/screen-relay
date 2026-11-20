#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace relay {
/** A hardware H.264 encoder from libavcodec that takes NV12 in system memory and returns one Annex B access unit per frame. */
class HwEncoder {
 public:
  /**
   * Opens the named libavcodec encoder, or with "auto" the first platform encoder that encodes an IDR; returns null when none works.
   * With bgra, an encoder that converts colour itself takes the captured BGRA pixels in plane 0 instead of NV12.
   */
  static std::unique_ptr<HwEncoder> open(const std::string& name, int width, int height, unsigned fps, uint64_t bitrate, bool bgra);
  /** Stops "auto" from choosing hardware again in this process, after an encoder failed while running. */
  static void disable();
  ~HwEncoder();
  /** True when plane 0 holds BGRA pixels for the encoder to convert, false when planes 0 and 1 hold NV12. */
  bool rgb() const;
  uint8_t* plane(int index) const;
  int stride(int index) const;
  const std::string& name() const;
  /** Encodes the picture in the planes and returns whether it is a keyframe; throws std::runtime_error on failure. */
  bool encode(int64_t pts_us, bool idr, uint64_t bitrate, std::vector<uint8_t>& annex_b);

 private:
  struct Impl;
  explicit HwEncoder(std::unique_ptr<Impl> impl);
  std::unique_ptr<Impl> impl_;
};
}  // namespace relay
