/* Full-screen high-motion X11 source: every pixel changes every frame at a fixed rate. */
#define _GNU_SOURCE
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: motion FPS\n"); return 2; }
  int fps = atoi(argv[1]);
  Display *d = XOpenDisplay(NULL);
  if (!d) { fprintf(stderr, "no display\n"); return 1; }
  int s = DefaultScreen(d);
  int w = DisplayWidth(d, s), h = DisplayHeight(d, s);
  XSetWindowAttributes a = { .override_redirect = True, .background_pixel = 0 };
  Window win = XCreateWindow(d, RootWindow(d, s), 0, 0, w, h, 0, CopyFromParent, InputOutput,
                             CopyFromParent, CWOverrideRedirect | CWBackPixel, &a);
  XMapRaised(d, win);
  GC gc = XCreateGC(d, win, 0, NULL);
  XShmSegmentInfo shm;
  XImage *img = XShmCreateImage(d, DefaultVisual(d, s), DefaultDepth(d, s), ZPixmap, NULL, &shm, w, h);
  shm.shmid = shmget(IPC_PRIVATE, img->bytes_per_line * h, IPC_CREAT | 0600);
  shm.shmaddr = img->data = shmat(shm.shmid, NULL, 0);
  shm.readOnly = False;
  XShmAttach(d, &shm);
  XSync(d, False);
  shmctl(shm.shmid, IPC_RMID, NULL);
  int tw = w * 2, th = h * 2;
  uint32_t *tex = malloc((size_t)tw * th * 4);
  uint32_t seed = 12345;
  for (int y = 0; y < th; y++)
    for (int x = 0; x < tw; x++) {
      seed = seed * 1103515245u + 12345u;
      uint32_t n = (seed >> 16) & 0x3f;
      uint32_t r = (x * 255 / tw + n) & 0xff, g = (y * 255 / th + n) & 0xff;
      uint32_t b = ((((x >> 5) ^ (y >> 5)) & 1) ? 200 : 40) + n;
      tex[(size_t)y * tw + x] = (r << 16) | (g << 8) | (b & 0xff);
    }
  struct timespec next;
  clock_gettime(CLOCK_MONOTONIC, &next);
  long period = 1000000000L / fps;
  for (unsigned t = 0;; t++) {
    int ox = (t * 7) % w, oy = (t * 3) % h;
    uint32_t add = (t * 3) & 0xff;
    uint32_t addv = add | (add << 8) | (add << 16);
    for (int y = 0; y < h; y++) {
      const uint32_t *src = tex + (size_t)(y + oy) * tw + ox;
      uint32_t *dst = (uint32_t *)(img->data + (size_t)y * img->bytes_per_line);
      for (int x = 0; x < w; x++) dst[x] = (src[x] ^ addv) & 0xffffff;
    }
    XShmPutImage(d, win, gc, img, 0, 0, 0, 0, w, h, False);
    XSync(d, False);
    next.tv_nsec += period;
    while (next.tv_nsec >= 1000000000L) { next.tv_nsec -= 1000000000L; next.tv_sec++; }
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    if (now.tv_sec > next.tv_sec || (now.tv_sec == next.tv_sec && now.tv_nsec > next.tv_nsec)) next = now;
    else clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next, NULL);
  }
}
