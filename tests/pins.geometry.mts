// Pin-geometry guard for the pin-visibility work.
//
// Dumps the absolute canvas coordinate of every pin on the boards and parts the
// marker change touches. The output is compared against the same dump taken
// with the marker change reverted: any drift in a pin position — or in the
// rotation maths wires use to find it — shows up as a diff rather than as a bug
// someone notices later.

import { resolveDefinition } from '../src/project/partsRegistry';
import { pinAbsolute } from '../src/canvas/geometry';
import { emptyProject } from '../src/project/templates';
import type { ComponentInstance } from '../src/types';

const PARTS = [
  'board.arduino-uno',
  'board.arduino-nano',
  'board.arduino-mega2560',
  'board.raspberry-pi-pico',
  'comp.bmp280',
  'comp.mpu6050',
];

const project = emptyProject('geometry');
const lines: string[] = [];

for (const defId of PARTS) {
  const def = resolveDefinition(defId, project);
  if (!def) {
    lines.push(`${defId}: MISSING DEFINITION`);
    continue;
  }
  // Two placements and three rotations, because wires resolve their endpoints
  // through the same transform the marker sits in.
  for (const [x, y, rotation] of [
    [0, 0, 0],
    [137.5, 62.5, 0],
    [137.5, 62.5, 90],
    [137.5, 62.5, 270],
  ] as const) {
    const inst = {
      id: 'i1',
      definitionId: defId,
      x,
      y,
      rotation,
      properties: {},
      simulationState: {},
    } as ComponentInstance;
    for (const pin of def.pins) {
      const p = pinAbsolute(inst, def, pin);
      lines.push(`${defId} @${x},${y} r${rotation} ${pin.id} ${pin.type} ${p.x.toFixed(6)} ${p.y.toFixed(6)}`);
    }
  }
}

console.log(lines.join('\n'));
console.error(`${lines.length} pin coordinates dumped across ${PARTS.length} parts`);
