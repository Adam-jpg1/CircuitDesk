import type { CircuitProject, CustomDefinition, PartDefinition, PinDefinition } from '../types';
import { BOARD_DEFINITIONS } from '../boards/definitions';
import { COMPONENT_DEFINITIONS } from '../components-library/definitions';

const builtinIndex = new Map<string, PartDefinition>();
for (const b of BOARD_DEFINITIONS) builtinIndex.set(b.id, b);
for (const c of COMPONENT_DEFINITIONS) builtinIndex.set(c.id, c);

/** Library-level custom parts (shared across projects), kept in sync by the custom-parts store. */
const libraryCustomIndex = new Map<string, PartDefinition>();

export function setLibraryCustomParts(parts: CustomDefinition[]): void {
  libraryCustomIndex.clear();
  for (const p of parts) libraryCustomIndex.set(p.definition.id, p.definition);
}

export function resolveDefinition(id: string, project?: CircuitProject | null): PartDefinition | undefined {
  const builtin = builtinIndex.get(id);
  if (builtin) return builtin;
  const projectCustom = project?.customDefinitions.find((c) => c.definition.id === id);
  if (projectCustom) return projectCustom.definition;
  return libraryCustomIndex.get(id);
}

/**
 * Finds a pin by its current id, or by an id it used to have.
 *
 * Aliases exist so a board definition can be corrected without invalidating
 * projects already saved against it. When the ESP32-C3 entry was rebuilt as a
 * real ESP32-C3-DevKitM-1 its pin identifiers changed to the ones printed on
 * the board, and every stored connection referencing the old names still has
 * to resolve to the same physical pin.
 */
export function resolvePin(def: PartDefinition | undefined, pinId: string): PinDefinition | undefined {
  if (!def) return undefined;
  return def.pins.find((p) => p.id === pinId) ?? def.pins.find((p) => p.aliases?.includes(pinId));
}

export function allBuiltinParts(): PartDefinition[] {
  return [...builtinIndex.values()];
}
