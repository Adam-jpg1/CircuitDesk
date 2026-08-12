// The pinned core manifest, typed, for everything on the server that needs it.
//
// Reads the same cores.json the image bootstrap does. The point is that there
// is exactly one list: when the capability endpoint says "esp32:esp32 3.3.11 is
// what this service is built for", that claim comes from the file the installer
// obeyed, not from a constant somebody remembered to update alongside it.

import manifest from './cores.json' with { type: 'json' };

export interface PinnedCore {
  /** arduino-cli package:architecture, e.g. "esp32:esp32". */
  id: string;
  /** The exact version this service is validated against. */
  version: string;
  /** Third-party package index, for cores outside the Arduino one. */
  additionalUrl?: string;
  /** FQBNs this core provides that CircuitDesk offers. */
  targets: string[];
  /** True when the deployment is not considered healthy without it. */
  required: boolean;
  /** Chips kept when the core is pruned to what CircuitDesk can compile. */
  keepChips?: string[];
  note?: string;
}

export const PINNED_CORES: PinnedCore[] = (manifest.cores as PinnedCore[]).map((c) => ({
  ...c,
  required: c.required !== false,
}));

export function pinnedCore(id: string): PinnedCore | undefined {
  return PINNED_CORES.find((c) => c.id === id);
}
