// Simulator adapter registry. A board can only be simulated through an
// adapter that explicitly lists its id — there is no default adapter and no
// fallback to the Uno profile. Emulator code is loaded lazily so board-family
// engines stay out of the startup path.

import type { BoardDefinition } from '../types';
import type { AVRRunner } from './avrRunner';
// Pure data (no avr8js), already part of the main chunk — imported statically
// so only the emulator itself is lazily loaded.
import { AVR_BOARD_PROFILES } from '../boards/pinMaps';

export interface BoardSimulatorAdapter {
  engine: 'avr8js';
  /** Canonical board ids this adapter genuinely supports (tested). */
  boardIds: string[];
  /** Lazily loads the engine and creates a runner with the board's own pin profile. */
  createRunner(hex: string, board: BoardDefinition): Promise<AVRRunner>;
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

const avr8jsAdapter: BoardSimulatorAdapter = {
  engine: 'avr8js',
  boardIds: ['board.arduino-uno', 'board.arduino-nano', 'board.arduino-mega2560', 'board.arduino-leonardo'],
  async createRunner(hex, board) {
    const { AVRRunner } = await import('./avrRunner');
    const profile = AVR_BOARD_PROFILES[board.id];
    if (!profile) {
      throw new Error(`No AVR pin profile is registered for ${board.name} (${board.id}) — refusing to run it on another board's profile.`);
    }
    return new AVRRunner(hex, profile);
  },
};

const ADAPTERS: BoardSimulatorAdapter[] = [avr8jsAdapter];

/** Returns the adapter for a board, or null when the board is not genuinely simulated. */
export function getSimulatorAdapter(board: BoardDefinition | undefined | null): BoardSimulatorAdapter | null {
  if (!board?.simulation?.supported || board.simulation.engine === 'none') return null;
  return ADAPTERS.find((a) => a.engine === board.simulation!.engine && a.boardIds.includes(board.id)) ?? null;
}

export function registeredSimulatedBoardIds(): string[] {
  return ADAPTERS.flatMap((a) => a.boardIds);
}
