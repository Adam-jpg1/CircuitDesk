// Simulator adapter registry. A board can only be simulated through an
// adapter that explicitly lists its id — there is no default adapter and no
// fallback to the Uno profile. Emulator code is loaded lazily so board-family
// engines stay out of the startup path.

import type { BoardDefinition } from '../types';
import type { AVRRunner } from './avrRunner';

export interface BoardSimulatorAdapter {
  engine: 'avr8js';
  /** Canonical board ids this adapter genuinely supports (tested). */
  boardIds: string[];
  /** Lazily loads the engine and creates a runner with the board's own pin profile. */
  createRunner(hex: string, board: BoardDefinition): Promise<AVRRunner>;
}

const avr8jsAdapter: BoardSimulatorAdapter = {
  engine: 'avr8js',
  boardIds: ['board.arduino-uno', 'board.arduino-nano'],
  async createRunner(hex, board) {
    const [{ AVRRunner }, { AVR_BOARD_PROFILES }] = await Promise.all([
      import('./avrRunner'),
      import('../boards/pinMaps'),
    ]);
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
