// An ESP32-C6 machine.
//
// The shared `EspRiscvMachine` provides the bus, the cache-through-MMU read
// path, the ROM call boundary, guest callbacks, interrupt plumbing and idle
// fast-forward. What this file adds is the C6's own configuration and the
// wiring of its own blocks — a flash MMU reached through a register port rather
// than a table, and an interrupt controller split across two addresses.
//
// Building this by copying the C3's machine would have produced something that
// runs and is wrong. The differences are listed against `ESP32C6_SOC`; the ones
// that would not have shown up as a crash are the dangerous ones, and the flash
// MMU's inverted valid bit is the clearest of them.

import { EspRiscvMachine, type EspMachineOptions } from '../espRiscv/machine';
import { ESP32C6_SOC } from '../espRiscv/soc';
import { createEsp32C6Peripherals, type Esp32C6Peripherals } from './peripherals';
import type { SerialNorFlash } from '../esp32c3/spiFlash';
import type { Esp32C3Gpio } from '../esp32c3/gpio';
import type { Esp32C6InterruptController } from './interrupts';

export { ESP32C6_SOC } from '../espRiscv/soc';

/** Documented ESP32-C6 address ranges this machine models. */
export const ESP32C6_MEMORY_MAP = ESP32C6_SOC.memory;

/** The stack the mask ROM is running on when it enters the application. */
export const ESP32C6_ROM_STACK_TOP = ESP32C6_SOC.romStackTop;

export class Esp32C6Machine extends EspRiscvMachine {
  constructor(options: EspMachineOptions = {}) {
    super(ESP32C6_SOC, options);
  }
}

export interface Esp32C6MachineParts {
  machine: Esp32C6Machine;
  gpio: Esp32C3Gpio;
  interrupts: Esp32C6InterruptController;
}

/**
 * Builds an ESP32-C6 with its peripherals installed.
 *
 * The interrupt controller occupies two register windows and is one object, so
 * something has to add both and register the half that can assert; doing it
 * here means no caller has to know that the C6 splits what the C3 keeps
 * together.
 */
export function createEsp32C6Machine(flash?: SerialNorFlash, options: EspMachineOptions = {}): Esp32C6MachineParts {
  const machine = new Esp32C6Machine(options);
  const parts: Esp32C6Peripherals = createEsp32C6Peripherals(machine, flash);
  for (const peripheral of parts.peripherals) machine.addPeripheral(peripheral);
  // The controller itself is what the machine consults for routing; its two
  // register windows went in above as ordinary peripherals, and INTPRI was
  // picked up there as a source in its own right because it carries the
  // software interrupts.
  machine.useInterruptRouter(parts.interrupts);
  return { machine, gpio: parts.gpio, interrupts: parts.interrupts };
}
