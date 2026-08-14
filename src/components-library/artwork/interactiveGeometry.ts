// Where a part's controls are, in one place.
//
// The canvas has to know what the pointer is over and the artwork has to draw
// it, and if those two answers are computed separately they will drift — a key
// that lights up when you press the one next to it is exactly the kind of bug
// that survives a long time because it looks almost right. So both read this.
//
// Coordinates are canvas units (the same units pin positions use), local to
// the component's own origin before rotation.

import { MM } from '../../boards/pinHelpers';
import { contactLayoutOf } from '../../simulation/devices/contactRegistry';
import { keyCapDescription } from '../../simulation/devices/matrixInput';
import { STARTER_REMOTE_KEYS } from '../../simulation/devices/irParts';
import type { ComponentDefinition, ComponentInstance } from '../../types';

export interface Hotspot {
  /** Contact key this control operates. `''` for a single-contact part. */
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corner radius, so the artwork and the hit area agree on shape. */
  radius: number;
  /** What the key says on it. */
  cap: string;
  /** For a tooltip: what the cap means. */
  title: string;
  /**
   * `momentary` closes while held; `latching` flips on each click.
   *
   * A keypad key is momentary because that is what a membrane switch does. A
   * DIP switch is latching because you set it and walk away.
   */
  kind: 'momentary' | 'latching';
}

/**
 * Vertical space reserved for the pin header, below the interactive area.
 *
 * Just enough for the header stubs and a little breathing room — reserving
 * more left a band of dead plastic under the keys that made the part look
 * unbalanced at 1:1.
 */
const HEADER_MM = 9;

/**
 * The key grid of a keypad or keyboard.
 *
 * Derived from the same layout the contacts come from, so the rect under the
 * pointer is guaranteed to be the contact that closes.
 */
function matrixHotspots(def: ComponentDefinition, instance: ComponentInstance): Hotspot[] {
  const layout = contactLayoutOf(def.id, instance);
  if (!layout) return [];
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const padY = 3.0 * MM;
  const gridW = W - 6 * MM;
  const gridH = H - padY - HEADER_MM * MM;
  const cw = gridW / layout.cols;
  const ch = gridH / layout.rows;
  const size = Math.min(cw, ch) * 0.86;
  return layout.keys.map((k) => ({
    key: k.key,
    x: 3 * MM + k.col * cw + (cw - size) / 2,
    y: padY + k.row * ch + (ch - size) / 2,
    w: size,
    h: size,
    radius: size * 0.18,
    cap: k.cap,
    title: keyCapDescription(k.cap),
    kind: 'momentary' as const,
  }));
}

/**
 * The keys of the virtual IR remote, three across.
 *
 * The remote has no pins and no wires, so unlike every other interactive part
 * there is no header to leave room for — the whole body is buttons. The keys
 * come from the same table the simulation sends codes from, so a cap and the
 * command behind it cannot drift apart.
 */
function remoteHotspots(def: ComponentDefinition): Hotspot[] {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const cols = 3;
  const rows = Math.ceil(STARTER_REMOTE_KEYS.length / cols);
  const marginX = 3 * MM;
  const marginY = 5 * MM;
  const cw = (W - marginX * 2) / cols;
  const ch = (H - marginY * 2) / rows;
  const size = Math.min(cw, ch) * 0.82;
  return STARTER_REMOTE_KEYS.map((k, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      key: k.key,
      x: marginX + col * cw + (cw - size) / 2,
      y: marginY + row * ch + (ch - size) / 2,
      w: size,
      h: size,
      radius: size / 2,
      cap: k.label,
      title: `Send NEC command 0x${k.command.toString(16).padStart(2, '0')}`,
      kind: 'momentary' as const,
    };
  });
}

/**
 * The individual poles of a DIP bank.
 *
 * The hit area is the whole pole column, not the actuator. A real DIP
 * actuator is about 1.7mm across, which is under seven pixels at 1:1 zoom —
 * accurate to draw and unusable to click. The drawing stays the real size and
 * the target around it is a full pitch wide, which is also how you would use
 * one on the bench: you aim at the numbered slot, not the nub.
 */
function dipHotspots(def: ComponentDefinition): Hotspot[] {
  const ways = Math.round((def.widthMm - 2.6) / 2.54);
  const H = def.heightMm * MM;
  const out: Hotspot[] = [];
  for (let i = 0; i < ways; i++) {
    const centre = 1.3 + (i + 0.5) * 2.54;
    out.push({
      key: `sw${i + 1}`,
      x: (centre - 1.27) * MM,
      y: 1.0 * MM,
      w: 2.54 * MM,
      h: H - 2.0 * MM,
      radius: 0.4,
      cap: String(i + 1),
      title: `Pole ${i + 1}`,
      kind: 'latching',
    });
  }
  return out;
}

/**
 * The actuator drawn inside a DIP pole's hit area.
 *
 * Derived from the hotspot so the two can never drift apart: the nub is always
 * centred in the slot the pointer is aimed at.
 */
export function dipActuatorRect(
  spot: Hotspot,
  on: boolean,
  /** The window it travels in, so the nub cannot end up outside it. */
  window?: { y: number; h: number },
): { x: number; y: number; w: number; h: number } {
  const w = 1.7 * MM;
  const top = window ? window.y + 0.4 : 2.3 * MM;
  const bottom = window ? window.y + window.h - 0.4 : 7.2 * MM;
  // Two positions with a gap between them, rather than a fixed height that
  // stopped fitting once the case made room to print the pole numbers.
  const h = (bottom - top) * 0.56;
  return {
    x: spot.x + (spot.w - w) / 2,
    y: on ? top : bottom - h,
    w,
    h,
  };
}

/** A control covering most of the part's body. */
function bodyHotspot(
  def: ComponentDefinition,
  key: string,
  cap: string,
  title: string,
  kind: Hotspot['kind'],
): Hotspot {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  return { key, x: 0, y: 0, w: W, h: H - 2 * MM, radius: 3, cap, title, kind };
}

/**
 * Every control on a part, or none for a part with nothing to press.
 *
 * The interaction `kind` is a property of the hardware rather than a UI
 * preference: a membrane key springs back and a DIP pole does not.
 */
export function interactiveHotspots(def: ComponentDefinition, instance: ComponentInstance): Hotspot[] {
  switch (def.simulationAdapterId) {
    case 'sim.keypad':
      return matrixHotspots(def, instance);
    case 'sim.ir-remote':
      return remoteHotspots(def);
    case 'sim.dip-switch':
      return dipHotspots(def);
    case 'sim.slide-switch':
      return [bodyHotspot(def, '', '', 'Slide the actuator', 'latching')];
    case 'sim.limit-switch':
      return [bodyHotspot(def, '', '', 'Press the lever', 'momentary')];
    case 'sim.rotary-encoder': {
      // Only the shaft click is a hotspot. Rotation is not a click — it is a
      // direction and a number of detents, which belongs in the inspector.
      const W = def.widthMm * MM;
      return [{ key: 'sw', x: W / 2 - 5.2 * MM, y: 5.8 * MM, w: 10.4 * MM, h: 10.4 * MM, radius: 5.2 * MM, cap: '', title: 'Press the shaft', kind: 'momentary' }];
    }
    case 'sim.joystick': {
      const W = def.widthMm * MM;
      return [{ key: 'sw', x: W / 2 - 6.8 * MM, y: 6.2 * MM, w: 13.6 * MM, h: 13.6 * MM, radius: 6.8 * MM, cap: '', title: 'Click the stick', kind: 'momentary' }];
    }
    default:
      return [];
  }
}

/** The hotspot under a point in the component's own coordinate space. */
export function hotspotAt(
  def: ComponentDefinition,
  instance: ComponentInstance,
  localX: number,
  localY: number,
): Hotspot | null {
  // Last first, so a control drawn on top of another wins the click the same
  // way it wins the paint.
  const spots = interactiveHotspots(def, instance);
  for (let i = spots.length - 1; i >= 0; i--) {
    const s = spots[i];
    if (localX >= s.x && localX <= s.x + s.w && localY >= s.y && localY <= s.y + s.h) return s;
  }
  return null;
}
