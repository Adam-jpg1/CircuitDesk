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

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json ./
COPY server ./server

ENV NODE_ENV=production
# Render injects PORT; default kept for local docker runs.
EXPOSE 3411

CMD ["npm", "run", "start:backend"]
