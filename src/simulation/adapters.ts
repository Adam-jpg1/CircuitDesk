// Simulator adapter registry. A board can only be simulated through an
// adapter that explicitly lists its id — there is no default adapter and no
// fallback to another board's profile or engine. Emulator code is loaded
// lazily, and each architecture is a separate dynamic import, so starting an
// AVR simulation never fetches the RP2040 engine and vice versa.

import type { BoardDefinition } from '../types';
import { runnerPinIndex, type BoardRunner } from './boardRunner';
// Pure data (no avr8js), already part of the main chunk — imported statically
// so only the emulator itself is lazily loaded.
import { avrProfileForProcessor } from '../boards/pinMaps';
// Firmware validation is pure and emulator-free, so a bad artifact is refused
// without downloading an engine chunk to find out.
import { decodeBase64Firmware, parseRp2040Uf2, FirmwareRejectedError } from './rp2040/uf2';
// The ESP image parser imports no emulator, so a wrong-architecture or
// malformed artifact is refused before any engine chunk is downloaded.
import { decodeBase64Image, parseEspApplicationImage, ESP32C6_REGIONS } from './esp32c3/espImage';

/** The compiler service's artifact, as handed to the simulator. */
export interface FirmwareArtifact {
  /** Intel HEX text for AVR, base64 UF2 for RP2040, base64 image for ESP. */
  data: string;
  format: string;
  /**
   * Other flash regions the toolchain produced, at their real offsets.
   *
   * An ESP32-C3 reads its partition table out of flash before it will run
   * anything, so the artifacts that are not executed still have to be present.
   */
  regions?: { offset: number; data: string }[];
}

export interface BoardSimulatorAdapter {
  engine: 'avr8js' | 'rp2040js' | 'esp32c3' | 'esp32c6' | 'samd21' | 'armv7m';
  /**
   * Processor profiles this adapter genuinely executes.
   *
   * Deliberately NOT a list of board ids. An adapter that named the boards it
   * supports would have to be edited every time somebody brought their own
   * board, and would make "is this a Raspberry Pi Pico" a question the emulator
   * asks — which is exactly the coupling that stops a custom RP2040 board from
   * running. What the emulator actually cares about is the chip.
   */
  processorProfileIds: string[];
  /** The artifact format this engine executes. */
  firmwareFormat: 'intel-hex' | 'uf2' | 'esp-image' | 'bin';
  /** Lazily loads the engine and creates a runner with the board's own profile. */
  createRunner(firmware: FirmwareArtifact, board: BoardDefinition): Promise<BoardRunner>;
}

/**
 * Rejects firmware that was not compiled for the board about to run it.
 * Firmware is tagged with the board id it was built for at compile time, so a
 * mismatch is refused outright instead of executing on the wrong CPU profile.
 */
export function assertFirmwareMatchesBoard(
  compiledForBoardId: string,
  board: Pick<BoardDefinition, 'id' | 'name'>,
): void {
  if (compiledForBoardId !== board.id) {
    throw new Error(
      `Firmware was compiled for "${compiledForBoardId}" but the canvas board is "${board.id}" (${board.name}). ` +
        'CircuitDesk will not execute firmware on a different MCU — recompile for this board.',
    );
  }
}

/**
 * Rejects an artifact whose format is not the one this engine executes.
 *
 * Without this an Intel HEX file would be handed to the RP2040 engine, or a
 * UF2 to avr8js, and the failure would surface as a confusing emulator error
 * rather than as the board mismatch it actually is.
 */
function assertFormat(adapter: BoardSimulatorAdapter, firmware: FirmwareArtifact, board: BoardDefinition): void {
  if (firmware.format === adapter.firmwareFormat) return;
  throw new FirmwareRejectedError(
    `${board.name} runs ${adapter.firmwareFormat.toUpperCase()} firmware, but the compiled artifact is "${firmware.format}". ` +
      'CircuitDesk will not execute firmware built for another architecture — recompile for this board.',
  );
}

const avr8jsAdapter: BoardSimulatorAdapter = {
  engine: 'avr8js',
  processorProfileIds: ['proc.atmega328p', 'proc.atmega2560', 'proc.atmega32u4'],
  firmwareFormat: 'intel-hex',
  async createRunner(firmware, board) {
    assertFormat(this, firmware, board);
    const { AVRRunner } = await import('./avrRunner');
    // Keyed by the PROCESSOR, not the board: an ATmega328P is an ATmega328P
    // whoever put it on a PCB, and the memory map, vector table and port layout
    // the emulator needs belong to the chip.
    const profile = avrProfileForProcessor(board.processorProfileId);
    if (!profile) {
      throw new Error(
        `No AVR machine profile is registered for ${board.name} (processor ${board.processorProfileId ?? 'unknown'}) — ` +
        "refusing to run it on another processor's profile.",
      );
    }
    return new AVRRunner(firmware.data, profile);
  },
};

const rp2040jsAdapter: BoardSimulatorAdapter = {
  engine: 'rp2040js',
  processorProfileIds: ['proc.rp2040'],
  firmwareFormat: 'uf2',
  async createRunner(firmware, board) {
    assertFormat(this, firmware, board);
    // Validate before fetching the engine chunk: a malformed or wrong-family
    // image is refused without downloading the emulator.
    const image = parseRp2040Uf2(decodeBase64Firmware(firmware.data));
    const { Rp2040Runner } = await import('./rp2040/rp2040Runner');
    return new Rp2040Runner(image);
  },
};

const esp32c3Adapter: BoardSimulatorAdapter = {
  engine: 'esp32c3',
  processorProfileIds: ['proc.esp32c3'],
  firmwareFormat: 'esp-image',
  async createRunner(firmware, board) {
    assertFormat(this, firmware, board);
    // Validated before the engine chunk is fetched: an image built for another
    // Espressif part, or an AVR or RP2040 artifact that reached here by
    // mistake, is refused without downloading an emulator to find out.
    const image = parseEspApplicationImage(decodeBase64Image(firmware.data));
    const { Esp32C3Runner, decodeRegion } = await import('./esp32c3Runner');
    return new Esp32C3Runner(
      image,
      (firmware.regions ?? []).map((r) => ({ offset: r.offset, data: decodeRegion(r.data) })),
    );
  },
};

const esp32c6Adapter: BoardSimulatorAdapter = {
  engine: 'esp32c6',
  processorProfileIds: ['proc.esp32c6'],
  firmwareFormat: 'esp-image',
  async createRunner(firmware, board) {
    assertFormat(this, firmware, board);
    // Parsed against the C6's own region table before the engine chunk is
    // fetched, so a C3 build — whose segments all fall outside the C6's memory
    // map — is refused here rather than executed on the wrong machine.
    const image = parseEspApplicationImage(decodeBase64Image(firmware.data), {
      expectChip: 'esp32c6',
      regions: ESP32C6_REGIONS,
    });
    const { Esp32C6Runner } = await import('./esp32c6Runner');
    const { decodeRegion } = await import('./espRiscvRunner');
    return new Esp32C6Runner(
      image,
      (firmware.regions ?? []).map((r) => ({ offset: r.offset, data: decodeRegion(r.data) })),
    );
  },
};

const samd21Adapter: BoardSimulatorAdapter = {
  engine: 'samd21',
  processorProfileIds: ['proc.samd21'],
  firmwareFormat: 'intel-hex',
  async createRunner(firmware, board) {
    assertFormat(this, firmware, board);
    const { Samd21Runner } = await import('./samd21/samd21Runner');
    // Where the board's Wire and SPI are before begin() muxes them, so a part
    // wired on the canvas is on the bus from the first transaction.
    const padOf = (cap: string) => {
      const pin = board.pins.find((p) => p.capabilities.includes(cap as never));
      return pin ? runnerPinIndex(board, pin.id) : undefined;
    };
    return new Samd21Runner(firmware.data, {
      sda: padOf('i2c-sda'),
      scl: padOf('i2c-scl'),
      sck: padOf('spi-sck'),
      mosi: padOf('spi-mosi'),
      miso: padOf('spi-miso'),
    });
  },
};

/**
 * The ARMv7-M chips: one core, one runner, a chip model per processor.
 *
 * The artifact is the raw binary the core's toolchain writes, loaded at the
 * start of the chip's flash — which is where the image was linked.
 */
const armv7mAdapter: BoardSimulatorAdapter = {
  engine: 'armv7m',
  processorProfileIds: ['proc.sam3x8e', 'proc.stm32f401re', 'proc.ra4m1', 'proc.nrf52833', 'proc.nrf52840', 'proc.imxrt1062'],
  firmwareFormat: 'bin',
  async createRunner(firmware, board) {
    assertFormat(this, firmware, board);
    const image = decodeBase64Firmware(firmware.data);
    if (image.length < 8) throw new FirmwareRejectedError('The firmware image is empty.');
    const { ArmRunner } = await import('./armv7m/armRunner');
    const padOf = (cap: string) => {
      const pin = board.pins.find((p) => p.capabilities.includes(cap as never));
      return pin ? runnerPinIndex(board, pin.id) : undefined;
    };
    const busDefaults = {
      sda: padOf('i2c-sda'),
      scl: padOf('i2c-scl'),
      sck: padOf('spi-sck'),
      mosi: padOf('spi-mosi'),
      miso: padOf('spi-miso'),
    };
    switch (board.processorProfileId) {
      case 'proc.sam3x8e': {
        const { Sam3x } = await import('./sam3x/sam3x');
        // The vector table's reset handler has to land in flash, or this is not a SAM3X image.
        const reset = image[4] | (image[5] << 8) | (image[6] << 16) | (image[7] << 24);
        if (reset >>> 0 < 0x80000 || reset >>> 0 >= 0x100000) {
          throw new FirmwareRejectedError(
            `${board.name} runs images linked at 0x80000; this one starts at 0x${(reset >>> 0).toString(16)}. Recompile for this board.`,
          );
        }
        return new ArmRunner(() => {
          const chip = new Sam3x();
          chip.load(image);
          return chip;
        }, busDefaults);
      }
      case 'proc.stm32f401re': {
        const { Stm32f4 } = await import('./stm32f4/stm32f4');
        const reset = image[4] | (image[5] << 8) | (image[6] << 16) | (image[7] << 24);
        if (reset >>> 0 < 0x08000000 || reset >>> 0 >= 0x08080000) {
          throw new FirmwareRejectedError(
            `${board.name} runs images linked at 0x08000000; this one starts at 0x${(reset >>> 0).toString(16)}. Recompile for this board.`,
          );
        }
        return new ArmRunner(() => {
          const chip = new Stm32f4();
          chip.load(image);
          return chip;
        }, busDefaults);
      }
      case 'proc.ra4m1': {
        const { Ra4m1 } = await import('./ra4m1/ra4m1');
        // Linked above the 16 KB bootloader: the reset handler has to be there.
        const reset = image[4] | (image[5] << 8) | (image[6] << 16) | (image[7] << 24);
        if (reset >>> 0 < 0x4000 || reset >>> 0 >= 0x40000) {
          throw new FirmwareRejectedError(
            `${board.name} runs images linked at 0x4000; this one starts at 0x${(reset >>> 0).toString(16)}. Recompile for this board.`,
          );
        }
        return new ArmRunner(() => {
          const chip = new Ra4m1();
          chip.load(image);
          return chip;
        }, busDefaults);
      }
      case 'proc.nrf52833': {
        const { Nrf52 } = await import('./nrf52/nrf52');
        const reset = image[4] | (image[5] << 8) | (image[6] << 16) | (image[7] << 24);
        if (reset >>> 0 >= 0x80000) {
          throw new FirmwareRejectedError(
            `${board.name} runs images linked at 0; this one starts at 0x${(reset >>> 0).toString(16)}. Recompile for this board.`,
          );
        }
        return new ArmRunner(() => {
          const chip = new Nrf52('52833');
          chip.load(image);
          return chip;
        }, busDefaults);
      }
      case 'proc.nrf52840': {
        // The Nano 33 BLE's bootloader owns the first 64 KB; sketches are
        // linked at 0x10000 and the reset vector must point into them.
        const { Nrf52 } = await import('./nrf52/nrf52');
        const reset = image[4] | (image[5] << 8) | (image[6] << 16) | (image[7] << 24);
        if (reset >>> 0 < 0x10000 || reset >>> 0 >= 0x100000) {
          throw new FirmwareRejectedError(
            `${board.name} runs images linked at 0x10000, above its bootloader; this one starts at 0x${(reset >>> 0).toString(16)}. Recompile for this board.`,
          );
        }
        return new ArmRunner(() => {
          const chip = new Nrf52('52840');
          chip.load(image, 0x10000);
          return chip;
        }, busDefaults);
      }
      case 'proc.imxrt1062': {
        // The flash image from 0x60000000: the FlexSPI configuration block,
        // then the image vector table at 0x1000 the boot ROM reads.
        const { Imxrt1062 } = await import('./imxrt/imxrt1062');
        const ivt = image[0x1000] | (image[0x1001] << 8) | (image[0x1002] << 16) | (image[0x1003] << 24);
        if (image.length < 0x1008 || (ivt & 0xff) !== 0xd1) {
          throw new FirmwareRejectedError(`${board.name} runs flash images with an image vector table at 0x1000; this one has none. Recompile for this board.`);
        }
        return new ArmRunner(() => {
          const chip = new Imxrt1062();
          chip.load(image);
          return chip;
        }, busDefaults);
      }
      default:
        throw new Error(`No ARMv7-M chip model for processor ${board.processorProfileId}.`);
    }
  },
};

const ADAPTERS: BoardSimulatorAdapter[] = [avr8jsAdapter, rp2040jsAdapter, esp32c3Adapter, esp32c6Adapter, samd21Adapter, armv7mAdapter];

/**
 * The adapter for a board, or null when the board is not genuinely simulated.
 *
 * Three things have to agree, and each rules out a different mistake: the board
 * must claim simulation support, its runtime profile's engine must be the
 * adapter's, and the adapter must execute the board's processor. A board that
 * names a runtime for a chip that runtime cannot run gets null rather than a
 * confident emulator running the wrong machine.
 */
export function getSimulatorAdapter(board: BoardDefinition | undefined | null): BoardSimulatorAdapter | null {
  if (!board?.simulation?.supported || board.simulation.engine === 'none') return null;
  const processorId = board.processorProfileId;
  if (!processorId) return null;
  return (
    ADAPTERS.find((a) => a.engine === board.simulation!.engine && a.processorProfileIds.includes(processorId)) ?? null
  );
}

/** Processor profiles some adapter can execute. */
export function runnableProcessorProfileIds(): string[] {
  return [...new Set(ADAPTERS.flatMap((a) => a.processorProfileIds))];
}

/** The artifact format a board's engine executes, for the compile pipeline. */
export function firmwareFormatForBoard(
  board: BoardDefinition | undefined | null,
): 'intel-hex' | 'uf2' | 'esp-image' | 'bin' | null {
  return getSimulatorAdapter(board)?.firmwareFormat ?? null;
}
