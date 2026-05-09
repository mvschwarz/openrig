# OpenRig Containerized E2E Testing Image
#
# Provides: Node 22, tmux, agent-browser (with system Chromium), OpenRig CLI
# Usage:
#   1. Build the CLI tarball: cd <repo>/packages/cli && npm pack
#   2. Copy tarball to build context as openrig-cli.tgz
#   3. docker build -t openrig-e2e .
#   4. docker run -it --rm --shm-size=1g -v /tmp/e2e-artifacts:/artifacts openrig-e2e
#
# ARM64 note: Chrome for Testing is unavailable on Linux ARM64.
# This image uses Debian's system chromium instead, pointed via
# AGENT_BROWSER_EXECUTABLE_PATH.

FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV AGENT_BROWSER_ARGS=--no-sandbox
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV OPENRIG_HOME=/root/.openrig

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    git \
    procps \
    tmux \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g agent-browser

COPY openrig-cli.tgz /tmp/openrig-cli.tgz
RUN npm install -g /tmp/openrig-cli.tgz \
 && rm /tmp/openrig-cli.tgz

WORKDIR /workspace

CMD ["/bin/bash"]
