# A Vercel Sandbox image with screen-relay preinstalled, so `screen-relay up`
# starts a desktop without installing anything first. Build it from the
# repository root:
#   docker build -f images/vercel-sandbox/Dockerfile \
#     --build-arg SOURCE_REVISION=$(git rev-parse HEAD) .
ARG BASE_IMAGE=vcr.vercel.com/vercel/sandbox/node:24
FROM ${BASE_IMAGE}

USER root
ENV HOME=/root
# Keep npm from reading /vercel/.npmrc as project config.
WORKDIR /

# SOURCE_REVISION is the screen-relay commit the image is built from, named in
# the image's license notes. The first step fails without it.
ARG SOURCE_REVISION

# Install screen-relay from this checkout, so the image matches the commit.
# The checkout is also kept as a tarball, the source of the prebuilt engine.
COPY . /opt/relay-src
RUN : "${SOURCE_REVISION:?pass --build-arg SOURCE_REVISION=\$(git rev-parse HEAD)}" && \
    mkdir -p /usr/share/doc/screen-relay/source && \
    tar -czf /usr/share/doc/screen-relay/source/screen-relay.tar.gz \
      -C /opt/relay-src --exclude=./node_modules --exclude=./dist . && \
    cd /opt/relay-src && \
    npm ci --ignore-scripts && \
    npm run build && \
    npm install -g "$(npm pack --silent)" && \
    cd / && rm -rf /opt/relay-src && npm cache clean --force

# Install the X11 and XFCE packages, so `screen-relay install` only has to
# build the engine. xdotool sends input to the display while a viewer holds
# screen-relay's single input connection.
ARG DEBIAN_FRONTEND=noninteractive
RUN packages=$(awk -F '\t' '$1 == "core" || $1 == "x11" || $1 == "xfce" { print $3 }' \
      "$(npm root -g)/screen-relay/packages.tsv" | tr ' ' '\n' | grep -vx -- '-') && \
    apt-get update -o Acquire::Retries=10 && \
    apt-get install -y --no-install-recommends -o Acquire::Retries=10 $packages xdotool && \
    rm -rf /var/lib/apt/lists/*

ENV HOME=/vercel
USER ubuntu
WORKDIR /vercel

# Builds the engine under ~/.local/share/screen-relay.
RUN screen-relay install --yes && \
    screen-relay doctor && \
    command -v xdotool

# The prebuilt engine links x264, so it is distributed under GPL-3.0, while
# screen-relay's own source is Apache-2.0. The image carries what GPL-3.0 asks
# of a binary: the license texts, x264's license and copyright notices, and the
# exact source of both in source/ (x264's from apt-get source), so no pointer
# can go stale. deb-src is on only for that fetch, so the shipped image's apt
# doesn't pull source indexes.
USER root
RUN set -eu; \
    relay="$(HOME=/root npm root -g)/screen-relay"; \
    version=$(node -p "require('$relay/package.json').version"); \
    doc=/usr/share/doc/screen-relay; \
    cp "$relay/LICENSE" "$relay/THIRD-PARTY-NOTICES.md" "$doc/"; \
    cp -r "$relay/LICENSES" "$doc/"; \
    x264=$(dpkg-query -W -f='${Package}\n' 'libx264-[0-9]*' | head -n1); \
    x264_name=$(dpkg-query -W -f='${source:Package}' "$x264"); \
    x264_version=$(dpkg-query -W -f='${source:Version}' "$x264"); \
    cp "/usr/share/doc/$x264/copyright" "$doc/x264-copyright"; \
    . /etc/os-release; \
    case "$ID" in \
      ubuntu) x264_url="https://launchpad.net/ubuntu/+source/$x264_name/$x264_version" ;; \
      *) x264_url="https://snapshot.debian.org/package/$x264_name/$x264_version/" ;; \
    esac; \
    apt_orig=$(mktemp -d); \
    for list in /etc/apt/sources.list.d/*.sources; do \
      [ -f "$list" ] && cp "$list" "$apt_orig/" && sed -i 's/^Types: deb$/Types: deb deb-src/' "$list"; \
    done; \
    [ ! -f /etc/apt/sources.list ] || sed -n 's/^deb /deb-src /p' /etc/apt/sources.list > /etc/apt/sources.list.d/src.list; \
    apt-get update -o Acquire::Retries=10 >/dev/null; \
    fetch=$(mktemp -d); chown _apt "$fetch"; \
    (cd "$fetch" && apt-get source --download-only -o Acquire::Retries=10 "$x264_name=$x264_version" >/dev/null); \
    mv "$fetch"/* "$doc/source/"; rmdir "$fetch"; \
    for orig in "$apt_orig"/*.sources; do \
      [ -f "$orig" ] && mv "$orig" /etc/apt/sources.list.d/; \
    done; \
    rmdir "$apt_orig"; rm -f /etc/apt/sources.list.d/src.list; \
    grep -h '^Types:' /etc/apt/sources.list.d/*.sources 2>/dev/null || true; \
    rm -rf /var/lib/apt/lists/*; \
    ls "$doc/source"/*.dsc >/dev/null; \
    printf '%s\n' \
      "This image contains screen-relay $version and a prebuilt engine that links x264." \
      "screen-relay's own source is licensed under Apache-2.0 (LICENSE)." \
      "The prebuilt engine with x264 is distributed under GPL-3.0 (LICENSES/GPL-3.0.txt)." \
      "x264's license and copyright notices are in x264-copyright." \
      "" \
      "Source, included in source/:" \
      "- screen-relay $version: source/screen-relay.tar.gz, commit $SOURCE_REVISION" \
      "  https://github.com/vercel-labs/screen-relay/tree/$SOURCE_REVISION" \
      "- x264 $x264_version from $PRETTY_NAME: source/${x264_name}_*" \
      "  $x264_url" \
      > "$doc/SOURCE"; \
    cat "$doc/SOURCE"; ls -la "$doc/source"
USER ubuntu
