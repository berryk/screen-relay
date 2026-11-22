// Resizes an X desktop with RandR so it matches a viewer's window.
//
// Works with servers whose output accepts arbitrary modes, such as Xvnc
// (TigerVNC, KasmVNC) and Xvfb with RandR. The framebuffer and the output's
// CRTC must change together: a window manager lays windows out to the output,
// not the framebuffer, and the CRTC must always fit inside the framebuffer. So
// grow the framebuffer to cover both sizes, switch the CRTC, then shrink the
// framebuffer to the target.
#include <X11/Xlib.h>
#include <X11/extensions/Xrandr.h>
#include <algorithm>
#include <atomic>
#include <memory>
#include <mutex>
#include <string>

namespace relay {
namespace {
// Xlib's error handler is process-wide; errors on other connections go to the previous one.
std::atomic<Display*> resize_display{nullptr};
std::atomic<int> resize_error{0};
std::atomic<XErrorHandler> resize_previous{nullptr};
std::mutex resize_mutex;
int resizeErrorHandler(Display* display, XErrorEvent* event) {
  if (display == resize_display.load()) { resize_error = event->error_code ? event->error_code : 1; return 0; }
  const auto previous = resize_previous.load();
  return previous ? previous(display, event) : 0;
}
struct DisplayCloser { void operator()(Display* d) const { if (d) XCloseDisplay(d); } };
struct ResourcesFree { void operator()(XRRScreenResources* r) const { if (r) XRRFreeScreenResources(r); } };
struct OutputFree { void operator()(XRROutputInfo* o) const { if (o) XRRFreeOutputInfo(o); } };
struct CrtcFree { void operator()(XRRCrtcInfo* c) const { if (c) XRRFreeCrtcInfo(c); } };
// Physical size for the new framebuffer at 96 DPI, so toolkits keep their scale.
int millimeters(int pixels) { return std::max(1, int(pixels * 25.4 / 96 + 0.5)); }
}  // namespace

namespace x11 {
bool resizeDesktop(int width, int height, std::string& error) {
  std::lock_guard<std::mutex> lock(resize_mutex);
  std::unique_ptr<Display, DisplayCloser> display(XOpenDisplay(nullptr));
  if (!display) { error = "opening X display failed"; return false; }
  Display* d = display.get();
  int event_base = 0, error_base = 0;
  if (!XRRQueryExtension(d, &event_base, &error_base)) { error = "RandR unavailable"; return false; }
  const int screen = DefaultScreen(d);
  const Window root = RootWindow(d, screen);
  std::unique_ptr<XRRScreenResources, ResourcesFree> resources(XRRGetScreenResourcesCurrent(d, root));
  if (!resources) { error = "reading RandR screen resources failed"; return false; }

  // The primary output, else the first connected output that drives a CRTC.
  RROutput output = XRRGetOutputPrimary(d, root);
  std::unique_ptr<XRROutputInfo, OutputFree> info;
  if (output) info.reset(XRRGetOutputInfo(d, resources.get(), output));
  if (!info || info->connection != RR_Connected || !info->crtc) {
    info.reset(); output = 0;
    for (int i = 0; i < resources->noutput; ++i) {
      std::unique_ptr<XRROutputInfo, OutputFree> candidate(XRRGetOutputInfo(d, resources.get(), resources->outputs[i]));
      if (candidate && candidate->connection == RR_Connected && candidate->crtc) {
        output = resources->outputs[i]; info = std::move(candidate); break;
      }
    }
  }
  if (!info) { error = "no connected RandR output with a CRTC"; return false; }
  const RRCrtc crtc = info->crtc;
  std::unique_ptr<XRRCrtcInfo, CrtcFree> crtc_info(XRRGetCrtcInfo(d, resources.get(), crtc));
  if (!crtc_info) { error = "reading the CRTC failed"; return false; }

  const int current_width = DisplayWidth(d, screen), current_height = DisplayHeight(d, screen);
  if (int(crtc_info->width) == width && int(crtc_info->height) == height &&
      current_width == width && current_height == height) return true;

  int min_width = 0, min_height = 0, max_width = 0, max_height = 0;
  if (XRRGetScreenSizeRange(d, root, &min_width, &min_height, &max_width, &max_height) &&
      (width < min_width || height < min_height || width > max_width || height > max_height)) {
    error = "size outside the screen's RandR range " + std::to_string(min_width) + "x" + std::to_string(min_height) +
            " to " + std::to_string(max_width) + "x" + std::to_string(max_height);
    return false;
  }

  XSync(d, False);
  resize_display = d; resize_error = 0;
  resize_previous = XSetErrorHandler(resizeErrorHandler);
  auto restore = [&] {
    XSync(d, False);
    XSetErrorHandler(resize_previous.load());
    resize_display = nullptr;
  };

  // Reuse a mode of this size, adding it to the output if needed; otherwise create one.
  RRMode mode = 0;
  for (int i = 0; i < resources->nmode && !mode; ++i)
    if (int(resources->modes[i].width) == width && int(resources->modes[i].height) == height) mode = resources->modes[i].id;
  bool on_output = false;
  for (int i = 0; mode && i < info->nmode; ++i) if (info->modes[i] == mode) on_output = true;
  if (!mode) {
    const std::string name = std::to_string(width) + "x" + std::to_string(height);
    XRRModeInfo* mode_info = XRRAllocModeInfo(name.c_str(), int(name.size()));
    mode_info->width = unsigned(width); mode_info->height = unsigned(height);
    mode_info->hTotal = unsigned(width); mode_info->vTotal = unsigned(height);
    mode_info->hSyncStart = mode_info->hSyncEnd = unsigned(width);
    mode_info->vSyncStart = mode_info->vSyncEnd = unsigned(height);
    mode_info->dotClock = static_cast<unsigned long>(width) * height * 60;
    mode = XRRCreateMode(d, root, mode_info);
    XRRFreeModeInfo(mode_info);
  }
  if (mode && !on_output) XRRAddOutputMode(d, output, mode);
  XSync(d, False);
  if (!mode || resize_error) {
    restore();
    error = "creating the RandR mode failed";
    return false;
  }

  XGrabServer(d);
  const int cover_width = std::max(width, current_width), cover_height = std::max(height, current_height);
  if (cover_width != current_width || cover_height != current_height)
    XRRSetScreenSize(d, root, cover_width, cover_height, millimeters(cover_width), millimeters(cover_height));
  RROutput outputs[] = {output};
  const Status status = XRRSetCrtcConfig(d, resources.get(), crtc, CurrentTime, 0, 0, mode,
                                         crtc_info->rotation, outputs, 1);
  if (status == RRSetConfigSuccess && (cover_width != width || cover_height != height))
    XRRSetScreenSize(d, root, width, height, millimeters(width), millimeters(height));
  XUngrabServer(d);
  restore();
  if (status != RRSetConfigSuccess || resize_error) {
    error = "RandR rejected " + std::to_string(width) + "x" + std::to_string(height) +
            (resize_error ? " (X error " + std::to_string(resize_error.load()) + ")" : std::string());
    return false;
  }
  return true;
}
}  // namespace x11
}  // namespace relay
