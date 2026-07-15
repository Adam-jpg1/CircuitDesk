// Circuit graph: the source of truth for electrical connectivity.
// Nets are built with a union-find over component pins, merging explicit
// wires plus internal connectivity groups (breadboard rows, power rails,
// button sides are NOT merged here — those are dynamic switch elements).

import type { CircuitProject, ComponentInstance, Connection, PartDefinition } from '../types';
import { resolveDefinition } from '../project/partsRegistry';

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

  return { nets, netOf, instances, definitions, connections: project.connections };
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
