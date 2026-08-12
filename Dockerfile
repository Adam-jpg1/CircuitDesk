# CircuitDesk compiler backend — the real compilation service.
# Frontend is deployed separately (e.g. Vercel); this image runs only the API.

FROM node:22-bookworm-slim

# AVR toolchain + utilities. arduino-core-avr provides the Arduino AVR core for
# the avr-g++ fallback path; arduino-cli (installed below) is preferred. python3
# is required by the Arduino-Pico core: its build recipe shells out to python3,
# and without it an RP2040 build fails with "/usr/bin/env: 'python3': No such
# file or directory" (exit 127). The Arduino-ESP32 core needs it too.
RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc-avr \
      avr-libc \
      binutils-avr \
      arduino-core-avr \
      make \
      curl \
      ca-certificates \
      python3 \
      python3-venv \
    && rm -rf /var/lib/apt/lists/*

# arduino-cli, pinned. This used to take whatever install.sh on master offered,
# which is how the deployed service ran 1.5.1 while a development container ran
# a 1.5.2 release candidate. Keep in step with server/compiler/cores.json.
ARG ARDUINO_CLI_VERSION=1.5.1
RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
      | BINDIR=/usr/local/bin sh -s $ARDUINO_CLI_VERSION

# The cores this service promises, at the versions it is validated against.
#
# One manifest, one place. It used to be three `arduino-cli core install` lines
# here, unpinned, and esp32:esp32 was simply not among them — which is why a
# fresh deployment could compile for a Pico and not for an ESP32-C6 while a
# development container, where the core had been installed by hand, could do
# both. Both halves of that are fixed here: the list is data, and it is pinned.
#
# The installer prunes the parts of the ESP32 core CircuitDesk cannot compile
# for — the Xtensa toolchain, the per-chip libraries for parts not on the
# allowlist, the debuggers. See server/compiler/installCores.mjs.
#
# SIZE: this image carries three toolchains. Measured installed, on top of the
# ~400 MB base: arduino:avr ~260 MB, rp2040:rp2040 ~1.5 GB, esp32:esp32 ~2.8 GB
# after pruning (5.5 GB before). A deployment target must have the disk for it;
# ESP32_CORE=0 builds without the ESP targets, and the backend then reports
# CORE_MISSING for the C3 and C6 by name rather than compiling them as anything
# else.
ARG ESP32_CORE=1
COPY server/compiler/cores.json server/compiler/installCores.mjs /bootstrap/compiler/
RUN if [ "$ESP32_CORE" = "0" ]; then \
      node -e "const f='/bootstrap/compiler/cores.json',j=JSON.parse(require('fs').readFileSync(f,'utf8'));j.cores=j.cores.filter(c=>c.id!=='esp32:esp32');require('fs').writeFileSync(f,JSON.stringify(j))"; \
    fi \
 && node /bootstrap/compiler/installCores.mjs \
 && node /bootstrap/compiler/installCores.mjs --verify \
 && arduino-cli core list

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
