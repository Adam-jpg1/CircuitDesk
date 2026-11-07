// Pin ids that changed, and the wires that were connected to the old ones.
//
// A wire is stored as a pin ID, not a coordinate, which is what lets a part's
// artwork and footprint change without touching a saved project. The one thing
// that breaks is renaming a pin: `normalizeProject` drops connections whose pin
// no longer exists, so a rename with no migration silently deletes wires.
//
// So renames go here, gated on the schema version the project was saved at, and
// are applied before that filter runs. A rename may only appear here when the
// old pin and the new one are the SAME pin — same electrical node, same
// direction, same behaviour — because the migration moves the user's wire
// without asking. Anything ambiguous is not a migration; it is a question for
// the user, and it does not belong in this table.

import type { CircuitProject } from '../types';

export interface PinRename {
  /** Component definition the rename applies to. */
  definitionId: string;
  /** Pin id as saved by older versions. */
  from: string;
  /** Pin id it means now. */
  to: string;
  /** Projects at or above this schema version already use the new id. */
  fixedIn: string;
  /** Why the two are the same pin. Read by anyone auditing this table. */
  reason: string;
}

export const PIN_RENAMES: PinRename[] = [
  {
    definitionId: 'comp.cd4026',
    from: 'deo',
    to: 'dei',
    fixedIn: '1.1.0',
    reason:
      'The CD4026 has two display-enable pins and this part had one, named for the wrong one. ' +
      'The model read it with ctx.input(), and blanked the segments when it was low: that is ' +
      'DISPLAY ENABLE IN, which is now what it is called. A wire to the old "deo" was connected ' +
      'to the display-enable input and still is; only the name changed. The buffered output the ' +
      'datasheet calls DEO is a new pin, and no saved project can have been wired to it.',
  },
];

/** Compares dotted versions numerically: 1.10.0 is above 1.9.0. */
function versionAtLeast(version: string, target: string): boolean {
  const a = version.split('.').map((n) => Number(n) || 0);
  const b = target.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export interface PinMigrationReport {
  /** One entry per wire endpoint moved. */
  moved: { connectionId: string; definitionId: string; from: string; to: string }[];
}

/**
 * Rewrites wire endpoints that name a pin id which has since been renamed.
 *
 * Mutates the project in place and reports what it moved, so a load can say so
 * rather than a wire quietly appearing somewhere else. Idempotent: a project
 * already at or past a rename's `fixedIn` version is left alone, which is what
 * stops the rule from firing again on an id that is legitimately in use.
 */
export function migratePinIds(project: CircuitProject): PinMigrationReport {
  const moved: PinMigrationReport['moved'] = [];
  const applicable = PIN_RENAMES.filter((r) => !versionAtLeast(project.version, r.fixedIn));
  if (applicable.length === 0) return { moved };

  const definitionOf = new Map(
    [...project.boardInstances, ...project.componentInstances].map((i) => [i.id, i.definitionId] as const),
  );

  for (const connection of project.connections) {
    for (const end of ['source', 'target'] as const) {
      const instanceId = connection[`${end}ComponentId`];
      const pinId = connection[`${end}PinId`];
      const definitionId = definitionOf.get(instanceId);
      if (!definitionId) continue;
      const rule = applicable.find((r) => r.definitionId === definitionId && r.from === pinId);
      if (!rule) continue;
      connection[`${end}PinId`] = rule.to;
      moved.push({ connectionId: connection.id, definitionId, from: rule.from, to: rule.to });
    }
  }
  return { moved };
}
