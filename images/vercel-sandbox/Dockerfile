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
