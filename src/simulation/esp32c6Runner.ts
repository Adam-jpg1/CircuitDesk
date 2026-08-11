// The production ESP32-C6 board runner.
//
// A thin file on purpose. Everything a runner does — slicing simulated time,
// measuring pad duty and pulse widths, reporting pin changes, scheduling
// events, reset and dispose — is shared with the C3 in `espRiscvRunner`,
// because none of it depends on which Espressif RISC-V part is underneath.
// What differs is the machine and how many pads the chip has, and that is all
// this file supplies.
//
// This module imports the C6 emulator, so it must only ever be reached through
// the adapter's dynamic import. Nothing in the startup bundle may import it.

import { EspRiscvRunner, type EspRunnerConfig } from './espRiscvRunner';
import { createEsp32C6Machine } from './esp32c6/esp32c6Machine';
import { parseEspApplicationImage, ESP32C6_REGIONS, type EspApplicationImage } from './esp32c3/espImage';
import { decodeRegion } from './espRiscvRunner';
import type { SerialNorFlash } from './esp32c3/spiFlash';

/** The ESP32-C6: 31 GPIOs, SOC_GPIO_PIN_COUNT. */
export const ESP32C6_RUNNER_CONFIG: EspRunnerConfig = {
  engine: 'esp32c6',
  pinCount: 31,
  build(flash: SerialNorFlash) {
    const { machine, gpio } = createEsp32C6Machine(flash);
    return { machine, gpio };
  },
};

export class Esp32C6Runner extends EspRiscvRunner {
  constructor(image: EspApplicationImage, regions: { offset: number; data: Uint8Array }[]) {
    super(image, regions, ESP32C6_RUNNER_CONFIG);
  }
}

/**
 * Builds a C6 runner from the compiler service's artifacts.
 *
 * The image is parsed against the C6's own region table, so a C3 build that
 * reached here by mistake is refused rather than executed on the wrong machine.
 */
export function createEsp32C6Runner(
  applicationImage: Uint8Array,
  regions: { offset: number; data: string }[] = [],
): Esp32C6Runner {
  const image = parseEspApplicationImage(applicationImage, { expectChip: 'esp32c6', regions: ESP32C6_REGIONS });
  return new Esp32C6Runner(
    image,
    regions.map((r) => ({ offset: r.offset, data: decodeRegion(r.data) })),
  );
}
