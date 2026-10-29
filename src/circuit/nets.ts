// Circuit graph: the source of truth for electrical connectivity.
// Nets are built with a union-find over component pins, merging explicit
// wires plus internal connectivity groups (breadboard rows, power rails,
// button sides are NOT merged here — those are dynamic switch elements).
//
// Two kinds of connection need no wire. A part pushed into a breadboard is
// connected through the holes its legs sit in, exactly as on a bench — found
// from where the pins are, so it follows the part when it moves. And a
// board's GND pins are one piece of copper, so a circuit grounded on one GND
// pin and powered against another is a closed loop.

import type { CircuitProject, ComponentInstance, Connection, PartDefinition } from '../types';
import { resolveDefinition } from '../project/partsRegistry';
import { pinAbsolute } from '../canvas/geometry';
import { MM } from '../boards/pinHelpers';

/**
 * How close a pin has to be to a breadboard hole to be in it: half the 2.54 mm
 * pitch, so a leg over the hole grid is in its nearest hole — a resistor's legs
 * are not a whole number of holes apart, and on a bench they bend to fit.
 */
export const BREADBOARD_SEAT_MM = 1.27;

/**
 * The nudge that puts a part's legs into breadboard holes: the offset from
 * the pin nearest to a hole onto that hole, or null when no pin is within
 * half a pitch of one.
 */
export function seatingOffset(
  part: ComponentInstance,
  def: PartDefinition,
  instances: ComponentInstance[],
  definitions: Map<string, PartDefinition>,
): { dx: number; dy: number } | null {
  if (isBreadboard(def)) return null;
  const reach = BREADBOARD_SEAT_MM * MM;
  let best: { dx: number; dy: number; d: number } | null = null;
  for (const bb of instances) {
    const bbDef = definitions.get(bb.id);
    if (!isBreadboard(bbDef)) continue;
    for (const pin of def.pins) {
      const at = pinAbsolute(part, def, pin);
      for (const hole of bbDef!.pins) {
        const h = pinAbsolute(bb, bbDef!, hole);
        const d = Math.hypot(h.x - at.x, h.y - at.y);
        if (d <= reach && (!best || d < best.d)) best = { dx: h.x - at.x, dy: h.y - at.y, d };
      }
    }
  }
  return best && best.d > 1e-6 ? { dx: best.dx, dy: best.dy } : null;
}

export function isBreadboard(def: PartDefinition | undefined): boolean {
  return !!def && !def.isBoard && def.id.startsWith('comp.breadboard');
}

export type NodeKey = string; // `${componentId}:${pinId}`

export function nodeKey(componentId: string, pinId: string): NodeKey {
  return `${componentId}:${pinId}`;
}

export interface Net {
  id: string;
  nodes: NodeKey[];
}

export interface CircuitGraph {
  nets: Net[];
  netOf: Map<NodeKey, string>;
  instances: ComponentInstance[];
  definitions: Map<string, PartDefinition>;
  connections: Connection[];
  /** Part pins sitting in a breadboard hole, and the hole: `component:pin` → `breadboard:hole`. */
  seated: Map<NodeKey, NodeKey>;
}

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    let root = this.parent.get(x);
    if (root === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (root !== x) {
      root = this.find(root);
      this.parent.set(x, root);
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  keys(): string[] {
    return [...this.parent.keys()];
  }
}

export function buildCircuitGraph(project: CircuitProject): CircuitGraph {
  const instances = [...project.boardInstances, ...project.componentInstances];
  const definitions = new Map<string, PartDefinition>();
  const uf = new UnionFind();

  for (const inst of instances) {
    const def = resolveDefinition(inst.definitionId, project);
    if (!def) continue;
    definitions.set(inst.id, def);
    for (const pin of def.pins) {
      uf.find(nodeKey(inst.id, pin.id));
    }
    // Internal groups (e.g. breadboard rows) are permanently connected.
    if (!def.isBoard && def.internalGroups) {
      const groupFirst = new Map<string, string>();
      for (const [pinId, group] of Object.entries(def.internalGroups)) {
        const key = nodeKey(inst.id, pinId);
        const first = groupFirst.get(group);
        if (first) uf.union(first, key);
        else groupFirst.set(group, key);
      }
    }
  }

  for (const conn of project.connections) {
    uf.union(nodeKey(conn.sourceComponentId, conn.sourcePinId), nodeKey(conn.targetComponentId, conn.targetPinId));
  }

  // A board's ground pins are all the same copper.
  for (const inst of instances) {
    const def = definitions.get(inst.id);
    if (!def?.isBoard) continue;
    const grounds = def.pins.filter((p) => p.type === 'ground');
    for (let i = 1; i < grounds.length; i++) uf.union(nodeKey(inst.id, grounds[0].id), nodeKey(inst.id, grounds[i].id));
  }

  const seated = seatInBreadboards(instances, definitions);
  for (const [pinKey, holeKey] of seated) uf.union(pinKey, holeKey);

  const groups = new Map<string, NodeKey[]>();
  for (const key of uf.keys()) {
    const root = uf.find(key);
    const arr = groups.get(root);
    if (arr) arr.push(key);
    else groups.set(root, [key]);
  }

  const nets: Net[] = [];
  const netOf = new Map<NodeKey, string>();
  let i = 0;
  for (const [, nodes] of groups) {
    const id = `net_${i++}`;
    nets.push({ id, nodes });
    for (const n of nodes) netOf.set(n, id);
  }

  return { nets, netOf, instances, definitions, connections: project.connections, seated };
}

/**
 * Which part pins sit in which breadboard holes.
 *
 * Every hole's position is put in a grid of buckets the size of the tolerance,
 * so each pin only looks at the nine buckets around it. A breadboard's own
 * holes are never seated in another breadboard's, and a pin takes the nearest
 * hole if two are in reach.
 */
export function seatInBreadboards(
  instances: ComponentInstance[],
  definitions: Map<string, PartDefinition>,
): Map<NodeKey, NodeKey> {
  const seated = new Map<NodeKey, NodeKey>();
  const reach = BREADBOARD_SEAT_MM * MM;
  const buckets = new Map<string, { key: NodeKey; x: number; y: number }[]>();
  const cell = (v: number) => Math.floor(v / reach);
  let any = false;
  for (const inst of instances) {
    const def = definitions.get(inst.id);
    if (!isBreadboard(def)) continue;
    any = true;
    for (const pin of def!.pins) {
      const at = pinAbsolute(inst, def!, pin);
      const k = `${cell(at.x)},${cell(at.y)}`;
      const list = buckets.get(k) ?? [];
      list.push({ key: nodeKey(inst.id, pin.id), x: at.x, y: at.y });
      buckets.set(k, list);
    }
  }
  if (!any) return seated;
  for (const inst of instances) {
    const def = definitions.get(inst.id);
    if (!def || isBreadboard(def)) continue;
    for (const pin of def.pins) {
      const at = pinAbsolute(inst, def, pin);
      const cx = cell(at.x);
      const cy = cell(at.y);
      let best: NodeKey | null = null;
      let bestDist = reach;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const hole of buckets.get(`${cx + dx},${cy + dy}`) ?? []) {
            const d = Math.hypot(hole.x - at.x, hole.y - at.y);
            if (d <= bestDist) {
              bestDist = d;
              best = hole.key;
            }
          }
        }
      }
      if (best) seated.set(nodeKey(inst.id, pin.id), best);
    }
  }
  return seated;
}

/** True when the two pins are on the same electrical net. */
export function sameNet(graph: CircuitGraph, a: NodeKey, b: NodeKey): boolean {
  const na = graph.netOf.get(a);
  return na !== undefined && na === graph.netOf.get(b);
}

/** All nodes on nets connected to a given board pin type predicate. */
export function netsWhere(
  graph: CircuitGraph,
  predicate: (componentId: string, pinId: string) => boolean,
): Set<string> {
  const out = new Set<string>();
  for (const net of graph.nets) {
    for (const node of net.nodes) {
      const [componentId, pinId] = splitNode(node);
      if (predicate(componentId, pinId)) {
        out.add(net.id);
        break;
      }
    }
  }
  return out;
}

export function splitNode(node: NodeKey): [string, string] {
  const idx = node.indexOf(':');
  return [node.slice(0, idx), node.slice(idx + 1)];
}
