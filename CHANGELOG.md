# screen-relay

## 0.1.4

<!-- release:start -->

### New Features

- Added **single-connection grants**: `POST /grants/watch` and `POST /grants/control` take `connections=1` for a grant that opens one WebSocket. Its connection stays open, and every later handshake with the grant is refused (#98)
- Added the **Vercel Sandbox image** back, with a prebuilt engine distributed under GPL-3.0 because it links x264. The image carries the license texts, x264's notices, and the exact sources of both (#96)

### Improvements

- **Grant WebSockets connect from any page origin**, `Origin: null` included, so viewers embedded in MCP App hosts on opaque or per-load origins can connect. The session token and HTTP requests keep the `--allow-origin` check (#98)
- **Grant requests** reject an oversized query parameter with `invalid_query` and a repeated or invalid `connections` with `invalid_connections`, instead of ignoring the rest of the query (#98)

### Documentation

- Added the **GPL-3.0 text** in `LICENSES/GPL-3.0.txt` for the prebuilt engine, and noted it in the README and third-party notices (#96)

### Contributors

- @joshuasoup
- @lahfir

<!-- release:end -->

## 0.1.3

### New Features

- Added **scoped grants**: `POST /grants/watch` and `POST /grants/control` create a viewer credential with its own scope and lifetime, and `DELETE /grants/ID` revokes it and closes its connections. Grants replace the one-time viewer tickets from 0.1.2, and `POST /tickets` is gone (#74)
- Added **viewer control handoff**: the first viewer gets control when input is idle, and other viewers can watch or choose **Take control** from an agent (#70)
- Added **clipboard sync**: the viewer syncs text with the remote desktop while it holds control, and the CLI and SDK can read and set the remote clipboard (#71)

### Improvements

- **Browser origins** must now be listed for remote sessions. A session with `--public` accepts its own origin, loopback pages on the same address, and each origin in the new `--allow-origin` option, and never `Origin: null` (#76)
- The **engine listens on loopback** unless `--bind` sets an address, including with `--public` (#73)
- The **SDK** applies the same response body limit on every HTTP transport, and settles each request on completion, interruption, or its deadline (#78)
- **Named Wayland sessions** clear the runtime state they manage when the session stops (#79)

### Documentation

- Updated the **MCP app example** to use scoped grants, with watch access by default and optional control (#75)
- Guides store **client tokens** in owner-only files (#77)
- Described screen-relay as for **humans and AI agents** (#69)

### Contributors

- @lahfir

## 0.1.2

### New Features

- Added **one-time viewer tickets**: `POST /tickets` returns a ticket that opens one WebSocket within 60 seconds, so a custom client can connect without holding the session token (#64)

### Improvements

- **GitHub releases** no longer attach `relay-engine` binaries. `screen-relay install` already builds the engine on each machine (#67)

### Contributors

- @joshuasoup
- @lahfir

## 0.1.1

### New Features

- Added **Windows hosts**: `screen-relay install`, `up`, `down`, `status`, `logs`, `run`, and `doctor` work on Windows, with MSYS2 at `C:\msys64` providing the build tools and the libraries the engine loads (#57)

### Bug Fixes

- Fixed **TLS verification** skipping the host name check when the SDK was given a CA file. `ca` now checks the chain and the URL host name, and the new `certificate` option pins one exact server certificate (#54)
- Fixed **wheel scrolling** sending at least one notch for every wheel event, which scrolled the desktop dozens of notches during a short trackpad swipe. The viewer now adds up wheel distance and sends a notch for every 100 pixels (#61)
- Fixed **Windows setup** running an MSYS2 installation that another local account could have created first. `install` and `doctor` now check the owner and the write rules of the paths they run and load (#60)

### Improvements

- The **viewer opens view-only**. Choose **Take control** to own input and **Release control** to hand it back, so the CLI or SDK can send input while the viewer is open (#56)

### Documentation

- Added **platform demos** to the overview and to the Linux, macOS, and Windows pages (#59)
- Pointed documentation links at screen-relay.dev, showed screen-relay as a Labs experiment, and gave every diagram node even padding (#53, #55)

### Contributors

- @ctate
- @lahfir
- @Railly

## 0.1.0

### New Features

- Added the **install command**: `screen-relay install` installs the system packages and builds the engine on Linux and macOS. It replaces `./install.sh` (#52)
- Added **first-run setup to `up`**: on a machine that is not set up, `screen-relay up` asks which backend to use at a terminal, installs the packages, builds the engine, and then starts the session. Without a terminal it needs `--yes` (#52)

### Improvements

- Renamed the npm package, the CLI command, and the SDK import from `desktop-relay` and `relay` to **screen-relay**. Environment variables now start with `SCREEN_RELAY_`, the config file is `~/.config/screen-relay/config.yaml`, and session state is under `~/.local/state/screen-relay` (#52)
- The npm package now ships the **engine source**, so `npm install -g screen-relay` is the only install step. It needs Node 22 or newer (#52)
- Added the **Apache-2.0 license** and third-party notices (#52)

### Documentation

- Replaced the clone-and-install instructions with the npm commands in the docs and the agent skills (#52)

### Contributors

- @lahfir

## 0.0.1

### New Features

- First release of **relay**: the engine streams a Linux, macOS, or Windows desktop to a browser, and the `relay` CLI and the Node SDK control it
- The `desktop-relay` npm package ships the `relay` CLI, the Node SDK, and the agent skills
- Each GitHub release attaches a `relay-engine` binary for Linux x64 and ARM64, macOS ARM64 and x64, and Windows x64. A binary needs the x264 and libwebsockets libraries it was built against, so `./install.sh` remains the supported way to install the engine

### Contributors

- @ctate
- @lahfir

