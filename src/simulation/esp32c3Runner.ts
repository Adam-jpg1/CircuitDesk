// The production ESP32-C3 board runner.
//
// The runner itself is shared with the ESP32-C6 — see `espRiscvRunner` — because
// almost all of it is genuinely the same on both parts. This module keeps the
// C3's own entry points so nothing that already imports them has to change.

export {
  EspRiscvRunner,
  Esp32C3Runner,
  createEsp32C3Runner,
  decodeRegion,
  ESP32C3_RUNNER,
  type EspRunnerConfig,
} from './espRiscvRunner';
