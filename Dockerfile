# CircuitDesk compiler backend — real AVR compilation service.
# Frontend is deployed separately (e.g. Vercel); this image runs only the API.

FROM node:22-bookworm-slim

# AVR toolchain + utilities. arduino-core-avr provides the Arduino AVR core for
# the avr-g++ fallback path; arduino-cli (installed below) is preferred when its
# core download succeeds.
RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc-avr \
      avr-libc \
      binutils-avr \
      arduino-core-avr \
      make \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# arduino-cli + the arduino:avr core. Core installation needs network access at
# build time; if it fails the backend still compiles via avr-g++ + arduino-core-avr.
RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
      | BINDIR=/usr/local/bin sh \
    && (arduino-cli core update-index && arduino-cli core install arduino:avr) \
    || echo "arduino-cli core install failed; falling back to avr-g++ toolchain"

# RP2040 core (Raspberry Pi Pico / Pico W compile targets) — the Arduino-Pico
# core, FQBNs rp2040:rp2040:rpipico and rp2040:rp2040:rpipicow. It is the core
# the RP2040 emulator ecosystem is exercised against, and unlike the Mbed core
# it emits a .uf2 without also emitting a .hex, so an RP2040 build is never
# delivered as Intel HEX.
# SIZE TRADEOFF: this core plus its ARM toolchain and picotool measure ~1.6 GB
# installed. Remove this RUN to build a smaller AVR-only image — the backend
# then reports CORE_MISSING for the Pico with a clear message instead of ever
# falling back to another board.
ARG RP2040_INDEX=https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json
RUN (arduino-cli core update-index --additional-urls $RP2040_INDEX \
     && arduino-cli core install rp2040:rp2040 --additional-urls $RP2040_INDEX) \
    || echo "rp2040:rp2040 core install failed; Pico compiles will report CORE_MISSING"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json tsconfig.server.build.json ./
COPY server ./server

# Compile the backend to plain ESM, then drop the dev toolchain. The running
# container executes `node dist-server/index.js` directly: no npm wrapper, no
# tsx, no esbuild service. Those three cost ~144 MB of resident memory that a
# 512 MB instance cannot spare while arduino-cli is compiling.
RUN npm run build:server && npm prune --omit=dev && npm cache clean --force

ENV NODE_ENV=production
# One compiler job by default. arduino-cli otherwise picks one job per HOST
# CPU, which measured 685-690 MB peak RSS for a single RP2040 sketch — more
# than a 512 MB instance has, and the cause of out-of-memory restarts. Raise
# only on an instance with headroom to match.
ENV COMPILE_JOBS=1
# Render injects PORT; default kept for local docker runs.
EXPOSE 3411

CMD ["node", "dist-server/index.js"]
