# Debian with Node.js and npm, pinned for reproducible machine images.
FROM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

# Git/GitHub access, HTTP and JSON tools, fast search, and native build support.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bubblewrap \
        ca-certificates \
        curl \
        git \
        gh \
        jq \
        ripgrep \
        procps \
        build-essential \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# Package manager and coding agents. Versions match the supported BB providers.
RUN npm install -g \
        pnpm@9.15.9 \
        @earendil-works/pi-coding-agent@1.0.0 \
        @openai/codex@0.153.4 \
        @anthropic-ai/claude-code@2.1.263 \
    && npm cache clean --force

# Run agents as an unprivileged user with a writable home directory.
# BB installs its daemon on demand during bootstrap; it is not baked into this image.
USER node
WORKDIR /home/node
