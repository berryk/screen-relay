#pragma once

#include <cstddef>
#include <functional>
#include <optional>
#include <string>

namespace relay {
/// Largest clipboard text, in UTF-8 bytes, that the engine reads or writes.
constexpr size_t max_clipboard_bytes = 256 * 1024;
/// Runs on a backend thread after the desktop clipboard changes, including changes the engine made.
using ClipboardChanged = std::function<void()>;
/** Platform text clipboard with LF line endings. One caller at a time; each call returns within about two seconds. */
class ClipboardBackend {
 public:
  virtual ~ClipboardBackend() = default;
  /// The clipboard text as UTF-8, empty when the clipboard holds no text, or nothing when it cannot be read in time.
  virtual std::optional<std::string> read() = 0;
  /// Replaces the clipboard with UTF-8 text; false when the desktop refused it.
  virtual bool write(const std::string& text) = 0;
};
}  // namespace relay
