// Capability-derived support levels and tooltip text. Badges are computed
// from declared+tested capabilities, never assigned ad hoc.

import type { BoardDefinition, PartDefinition, SupportLevel } from '../types';

/**
 * Derives a board's badge from its capabilities:
 *  - simulated: a registered simulator engine genuinely executes code (tested)
 *  - compile:   the backend has a strict toolchain target for the board
 *  - otherwise: the declared electrical tier (validation / wiring / visual).
 */
export function deriveBoardSupportLevel(
  board: Pick<BoardDefinition, 'compiler' | 'simulation'>,
  baseTier: SupportLevel,
): SupportLevel {
  if (board.simulation?.supported && board.simulation.engine !== 'none') return 'simulated';
  if (board.compiler?.supported && board.compiler.provider !== 'none') return 'compile';
  return baseTier === 'simulated' || baseTier === 'compile' ? 'validation' : baseTier;
}

/** Rich tooltip describing exactly what is and is not supported. */
export function describeSupport(def: PartDefinition): string {
  if (!def.isBoard) {
    switch (def.supportLevel) {
      case 'simulated':
        return `${def.name}: behavior is driven by real firmware execution in the simulator.`;
      case 'validation':
        return `${def.name}: wiring and electrical rules are checked; behavior is not simulated.`;
      case 'wiring':
        return `${def.name}: can be placed and wired with real pins; not validated in depth, not simulated.`;
      default:
        return `${def.name}: visual reference only.`;
    }
  }
  const lines: string[] = [def.name];
  const arch = def.architecture ?? 'other';
  lines.push(`Architecture: ${arch}${def.processor ? ` (${def.processor})` : ''}`);

  if (def.simulation?.supported) {
    lines.push(
      `Simulated: compiled firmware executes on the ${def.simulation.engine} engine with this board's own pin map.`,
    );
    if (def.simulation.supportedApis.length > 0) lines.push(`Verified APIs: ${def.simulation.supportedApis.join(', ')}.`);
    if (def.simulation.supportedPeripherals.length > 0) {
      lines.push(`Peripherals: ${def.simulation.supportedPeripherals.join(', ')}.`);
    }
  } else {
    lines.push('Not simulated — code does not execute inside CircuitDesk for this board.');
  }

  if (def.compiler?.supported && def.compiler.fqbn) {
    lines.push(`Compiles for the real target (${def.compiler.fqbn}).`);
    if (def.compiler.note) lines.push(def.compiler.note);
  } else if (def.compiler?.fqbn) {
    lines.push(`Compile target ${def.compiler.fqbn} defined but not enabled${def.compiler.note ? ` — ${def.compiler.note}` : '.'}`);
  } else {
    lines.push('No compiler toolchain for this board yet.');
  }

  // The badge must state what is NOT emulated, not only what is.
  const limitation = def.metadata?.limitation;
  if (typeof limitation === 'string' && limitation.length > 0) {
    lines.push(`Limitations: ${limitation}`);
  }
  return lines.join('\n');
}
