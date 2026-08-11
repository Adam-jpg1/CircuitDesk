// An ESP32-C3 machine.
//
// Everything general — the bus, the cache-through-MMU read path, the ROM call
// boundary, guest callbacks, interrupt plumbing — lives in the shared
// `EspRiscvMachine`, because the C6 needs exactly the same mechanisms. What is
// here is the C3's own configuration and the small amount of wiring that turns
// its peripheral classes into the roles the shared machine asks for.
//
// The re-exports below are not decoration: the C3's peripherals were written
// against these names, and moving the vocabulary into a leaf module would have
// meant editing every one of them for no behavioural gain.

import { EspRiscvMachine, type EspMachineOptions } from '../espRiscv/machine';
import { ESP32C3_SOC } from '../espRiscv/soc';

export {
  GUEST_RETURN_SENTINEL,
  CSR_PCCR_MACHINE,
  EspRiscvMachine,
  type EspMachineOptions,
} from '../espRiscv/machine';
export {
  GuestCallError,
  type GuestCallOptions,
  type GuestCallResult,
  type MmioEvent,
  type Peripheral,
  type RomCallEvent,
  type SimulatedClock,
} from '../espRiscv/peripheral';

/** Documented ESP32-C3 address ranges this machine models. */
export const MEMORY_MAP = ESP32C3_SOC.memory;

/**
 * The stack the mask ROM is running on when it enters the application.
 *
 * ESP-IDF names this SOC_ROM_STACK_START, and `call_start_cpu0` runs on it
 * until it switches to its own.
 */
export const ROM_STACK_TOP = ESP32C3_SOC.romStackTop;

/** Options accepted by an ESP32-C3 machine. */
export type Esp32C3MachineOptions = EspMachineOptions;

/**
 * An ESP32-C3.
 *
 * The C3's own blocks declare which of the machine's roles they fill — the
 * flash MMU, the interrupt router, the owner of the flash device — so this
 * class needs nothing beyond its configuration.
 */
export class Esp32C3Machine extends EspRiscvMachine {
  constructor(options: EspMachineOptions = {}) {
    super(ESP32C3_SOC, options);
  }
}
