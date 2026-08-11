// Simulator adapter registry. A board can only be simulated through an
// adapter that explicitly lists its id — there is no default adapter and no
// fallback to another board's profile or engine. Emulator code is loaded
// lazily, and each architecture is a separate dynamic import, so starting an
// AVR simulation never fetches the RP2040 engine and vice versa.

import type { BoardDefinition } from '../types';
import type { BoardRunner } from './boardRunner';
// Pure data (no avr8js), already part of the main chunk — imported statically
// so only the emulator itself is lazily loaded.
import { AVR_BOARD_PROFILES } from '../boards/pinMaps';
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
  engine: 'avr8js' | 'rp2040js' | 'esp32c3' | 'esp32c6';
  /** Canonical board ids this adapter genuinely supports (tested). */
  boardIds: string[];
  /** The artifact format this engine executes. */
  firmwareFormat: 'intel-hex' | 'uf2' | 'esp-image';
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
  boardIds: ['board.arduino-uno', 'board.arduino-nano', 'board.arduino-mega2560', 'board.arduino-leonardo'],
  firmwareFormat: 'intel-hex',
  async createRunner(firmware, board) {
    assertFormat(this, firmware, board);
    const { AVRRunner } = await import('./avrRunner');
    const profile = AVR_BOARD_PROFILES[board.id];
    if (!profile) {
      throw new Error(
        `No AVR pin profile is registered for ${board.name} (${board.id}) — refusing to run it on another board's profile.`,
      );
    }
    return new AVRRunner(firmware.data, profile);
  },
};

const rp2040jsAdapter: BoardSimulatorAdapter = {
  engine: 'rp2040js',
  boardIds: ['board.raspberry-pi-pico', 'board.raspberry-pi-pico-w'],
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
  boardIds: ['board.esp32-c3'],
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
  boardIds: ['board.esp32-c6-devkitc-1'],
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

const ADAPTERS: BoardSimulatorAdapter[] = [avr8jsAdapter, rp2040jsAdapter, esp32c3Adapter, esp32c6Adapter];

/** Returns the adapter for a board, or null when the board is not genuinely simulated. */
export function getSimulatorAdapter(board: BoardDefinition | undefined | null): BoardSimulatorAdapter | null {
  if (!board?.simulation?.supported || board.simulation.engine === 'none') return null;
  return ADAPTERS.find((a) => a.engine === board.simulation!.engine && a.boardIds.includes(board.id)) ?? null;
}

export function registeredSimulatedBoardIds(): string[] {
  return ADAPTERS.flatMap((a) => a.boardIds);
}

/** The artifact format a board's engine executes, for the compile pipeline. */
export function firmwareFormatForBoard(
  board: BoardDefinition | undefined | null,
): 'intel-hex' | 'uf2' | 'esp-image' | null {
  return getSimulatorAdapter(board)?.firmwareFormat ?? null;
}
