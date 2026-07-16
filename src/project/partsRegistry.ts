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

export function resolvePin(def: PartDefinition | undefined, pinId: string): PinDefinition | undefined {
  return def?.pins.find((p) => p.id === pinId);
}

export function allBuiltinParts(): PartDefinition[] {
  return [...builtinIndex.values()];
}
