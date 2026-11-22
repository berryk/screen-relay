#pragma once

#include "core/capture-source.hpp"
#include "core/clipboard.hpp"
#include "core/input.hpp"
#include <memory>
#include <string>

namespace relay {
struct Backend {
  const char* name;
  bool (*initialize)(const std::string& output);
  std::unique_ptr<CaptureSource> (*capture)();
  std::unique_ptr<InputBackend> (*input)();
  /// The desktop clipboard, or null when this desktop has none the engine can use.
  std::unique_ptr<ClipboardBackend> (*clipboard)(ClipboardChanged changed);
  /// Resizes the desktop to width x height, or null when this backend cannot.
  bool (*resize)(int width, int height, std::string& error) = nullptr;
};
const Backend& defaultBackend();
const Backend& backendFor(const std::string& name);
std::string backendNames();
}
