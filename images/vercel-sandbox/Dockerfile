# A Vercel Sandbox image with screen-relay preinstalled, so `screen-relay up`
# starts a desktop without installing anything first. Build it from the
# repository root: docker build -f images/vercel-sandbox/Dockerfile .
ARG BASE_IMAGE=vcr.vercel.com/vercel/sandbox/node:24
FROM ${BASE_IMAGE}

USER root
ENV HOME=/root
# Keep npm from reading /vercel/.npmrc as project config.
WORKDIR /

# Install screen-relay from this checkout, so the image matches the commit.
COPY . /opt/relay-src
RUN cd /opt/relay-src && \
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

# The prebuilt engine links x264, so the image carries what GPL-3.0 asks of a
# binary: the license texts, x264's license and copyright notices, and where
# to get the exact source of both. SOURCE_REVISION is the screen-relay commit
# the image was built from.
ARG SOURCE_REVISION=unknown
USER root
RUN set -eu; \
    relay="$(npm root -g)/screen-relay"; \
    version=$(node -p "require('$relay/package.json').version"); \
    doc=/usr/share/doc/screen-relay; \
    mkdir -p "$doc"; \
    cp "$relay/LICENSE" "$relay/THIRD-PARTY-NOTICES.md" "$doc/"; \
    cp -r "$relay/LICENSES" "$doc/"; \
    x264=$(dpkg-query -W -f='${Package}\n' 'libx264-[0-9]*' | head -n1); \
    x264_source=$(dpkg-query -W -f='${source:Package} ${source:Version}' "$x264"); \
    cp "/usr/share/doc/$x264/copyright" "$doc/x264-copyright"; \
    . /etc/os-release; \
    case "$ID" in \
      ubuntu) x264_url="https://launchpad.net/ubuntu/+source/${x264_source% *}/${x264_source#* }" ;; \
      *) x264_url="https://snapshot.debian.org/package/${x264_source% *}/${x264_source#* }/" ;; \
    esac; \
    printf '%s\n' \
      "This image contains screen-relay $version, whose engine links x264." \
      "The engine and x264 together are distributed under GPL-3.0-only (LICENSE)." \
      "x264's license and copyright notices are in x264-copyright." \
      "" \
      "Source:" \
      "- screen-relay: https://github.com/vercel-labs/screen-relay/tree/$SOURCE_REVISION (version $version)" \
      "- x264: $x264_source from $PRETTY_NAME, $x264_url" \
      "  or: apt-get source ${x264_source% *}=${x264_source#* }" \
      > "$doc/SOURCE"; \
    cat "$doc/SOURCE"
USER ubuntu
