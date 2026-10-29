// DC operating point of a circuit, by nodal analysis.
//
// This is the electrical model every part reads from: a battery lighting an
// LED through a resistor, a board pin driving one, a voltage divider on an
// analog pin. It knows nothing about boards, firmware or the canvas — callers
// describe the circuit as nets joined by elements and get back the voltage on
// every net and the current through every element.
//
// The method is Modified Nodal Analysis in its simplest form. Every source is
// a real one, an ideal voltage in series with an internal resistance, which
// makes it a Norton equivalent: a conductance plus an injected current. So the
// system is a plain conductance matrix with no extra unknowns, a short across
// a source gives a large but finite current rather than a singular matrix,
// and two sources fighting on one net settle at whatever their resistances
// divide to — which is what happens on a bench.
//
// Diodes and LEDs are piecewise linear: off, a diode is a leakage conductance;
// on, it is its forward voltage in series with a small resistance. Which ones
// are on is found by iteration — solve, turn on every off diode now forward
// biased past its knee, turn off every on diode whose current went negative,
// repeat until nothing changes. That converges in a handful of rounds for
// real circuits, and never produces the runaway values an exponential model
// can when it overshoots.
//
// References are automatic. Each separate island of the circuit gets its own
// zero: the node named as ground if the island has one, otherwise the negative
// terminal of its first source. An island with no source in it has no defined
// voltage at all, and is reported as floating rather than as zero volts.

export type CircuitElement =
  | {
      kind: 'resistor';
      id: string;
      a: string;
      b: string;
      ohms: number;
    }
  | {
      /** A voltage source with internal resistance: `volts` from minus to plus. */
      kind: 'source';
      id: string;
      plus: string;
      minus: string;
      volts: number;
      ohms: number;
    }
  | {
      /** Conducts anode to cathode once forward biased past `vf`, through `ohms`. */
      kind: 'diode';
      id: string;
      anode: string;
      cathode: string;
      vf: number;
      ohms: number;
    };

export interface DcSolution {
  /** Volts on every net in an island that has a source. */
  voltages: Map<string, number>;
  /**
   * Amps through every element: a resistor a→b, a diode anode→cathode, and a
   * source out of its plus terminal into the circuit.
   */
  currents: Map<string, number>;
  /** Nets in islands with no source: their voltage is undefined, not zero. */
  floating: Set<string>;
  /** Diodes that ended up conducting. */
  conducting: Set<string>;
  /**
   * Sources loaded below their own internal resistance — a short, or as good
   * as one. Their terminal voltage has collapsed to under half its rating.
   */
  shorts: string[];
  /** False when the diode states never settled; the last solution is returned. */
  converged: boolean;
  iterations: number;
  /** True when elimination hit a zero pivot. The result is still finite. */
  singular: boolean;
}

export interface SolveOptions {
  /** Nets to use as an island's 0 V reference in preference to anything else. */
  groundNodes?: Iterable<string>;
  maxIterations?: number;
}

/** Leakage of a diode that is off. */
const G_OFF = 1e-9;
/** Tiny conductance from every node to its reference, so no node is ever unconstrained. */
const G_MIN = 1e-12;
/** The smallest resistance anything is given: a closed switch, a jumper. */
const MIN_OHMS = 1e-3;

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = x;
    for (let next = this.parent.get(root); next !== undefined && next !== root; next = this.parent.get(root)) root = next;
    if (!this.parent.has(x)) this.parent.set(x, x);
    // Path compression.
    for (let at = x; at !== root; ) {
      const next = this.parent.get(at)!;
      this.parent.set(at, root);
      at = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function terminals(e: CircuitElement): [string, string] {
  switch (e.kind) {
    case 'resistor':
      return [e.a, e.b];
    case 'source':
      return [e.plus, e.minus];
    case 'diode':
      return [e.anode, e.cathode];
  }
}

/** Solves A·x = b in place by Gaussian elimination with partial pivoting. */
function gaussSolve(a: Float64Array[], b: Float64Array): { x: Float64Array; singular: boolean } {
  const n = b.length;
  let singular = false;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(a[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r][col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-18) {
      // Nothing constrains this unknown. G_MIN makes this unreachable for a
      // well-formed island; a degenerate one gets a zero rather than a NaN.
      singular = true;
      a[col][col] = 1;
      for (let r = col + 1; r < n; r++) a[r][col] = 0;
      b[col] = 0;
      continue;
    }
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot], a[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }
    const row = a[col];
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / row[col];
      if (f === 0) continue;
      const target = a[r];
      for (let c = col; c < n; c++) target[c] -= f * row[c];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r];
    for (let c = r + 1; c < n; c++) sum -= a[r][c] * x[c];
    x[r] = sum / a[r][r];
  }
  return { x, singular };
}

export function solveDc(elements: readonly CircuitElement[], options: SolveOptions = {}): DcSolution {
  const grounds = new Set(options.groundNodes ?? []);
  const maxIterations = options.maxIterations ?? 60;

  // Islands, and which of them have anything driving them.
  const uf = new UnionFind();
  for (const e of elements) {
    const [p, q] = terminals(e);
    uf.union(p, q);
  }
  const nodes = new Set<string>();
  for (const e of elements) for (const t of terminals(e)) nodes.add(t);

  const reference = new Map<string, string>(); // island root → reference node
  for (const g of grounds) if (nodes.has(g) && !reference.has(uf.find(g))) reference.set(uf.find(g), g);
  for (const e of elements) {
    if (e.kind !== 'source') continue;
    const root = uf.find(e.minus);
    if (!reference.has(root)) reference.set(root, e.minus);
  }
  const sourced = new Set<string>();
  for (const e of elements) if (e.kind === 'source') sourced.add(uf.find(e.plus));

  const floating = new Set<string>();
  const index = new Map<string, number>();
  const refOf = new Map<string, string>();
  for (const node of nodes) {
    const root = uf.find(node);
    if (!sourced.has(root)) {
      floating.add(node);
      continue;
    }
    const ref = reference.get(root)!;
    refOf.set(node, ref);
    if (node !== ref) index.set(node, index.size);
  }
  const n = index.size;
  const live = elements.filter((e) => !floating.has(terminals(e)[0]));
  const diodes = live.filter((e): e is Extract<CircuitElement, { kind: 'diode' }> => e.kind === 'diode');
  const on = new Set<string>();

  const solveOnce = () => {
    const a = Array.from({ length: n }, () => new Float64Array(n));
    const b = new Float64Array(n);
    const stampG = (p: string, q: string, g: number) => {
      const i = index.get(p);
      const j = index.get(q);
      if (i !== undefined) a[i][i] += g;
      if (j !== undefined) a[j][j] += g;
      if (i !== undefined && j !== undefined) {
        a[i][j] -= g;
        a[j][i] -= g;
      }
    };
    /** A current `amps` pushed into `p` and drawn out of `q`. */
    const inject = (p: string, q: string, amps: number) => {
      const i = index.get(p);
      const j = index.get(q);
      if (i !== undefined) b[i] += amps;
      if (j !== undefined) b[j] -= amps;
    };
    for (let i = 0; i < n; i++) a[i][i] += G_MIN;
    for (const e of live) {
      if (e.kind === 'resistor') {
        stampG(e.a, e.b, 1 / Math.max(MIN_OHMS, e.ohms));
      } else if (e.kind === 'source') {
        const g = 1 / Math.max(MIN_OHMS, e.ohms);
        stampG(e.plus, e.minus, g);
        inject(e.plus, e.minus, e.volts * g);
      } else if (on.has(e.id)) {
        const g = 1 / Math.max(MIN_OHMS, e.ohms);
        stampG(e.anode, e.cathode, g);
        inject(e.anode, e.cathode, e.vf * g);
      } else {
        stampG(e.anode, e.cathode, G_OFF);
      }
    }
    const { x, singular } = gaussSolve(a, b);
    const v = (node: string) => {
      const i = index.get(node);
      return i === undefined ? 0 : x[i];
    };
    return { v, singular };
  };

  let result = solveOnce();
  let iterations = 1;
  let converged = diodes.length === 0;
  const seen = new Set<string>();
  let oneAtATime = false;
  while (!converged && iterations < maxIterations) {
    const flips: { id: string; by: number }[] = [];
    for (const d of diodes) {
      const across = result.v(d.anode) - result.v(d.cathode);
      if (on.has(d.id)) {
        // Current through an on diode is (across - vf) / R; negative means it
        // would have to conduct backwards, so it turns off.
        if (across - d.vf < -1e-9) flips.push({ id: d.id, by: d.vf - across });
      } else if (across - d.vf > 1e-9) {
        flips.push({ id: d.id, by: across - d.vf });
      }
    }
    if (flips.length === 0) {
      converged = true;
      break;
    }
    // Flipping every violator at once is fast and almost always right; if it
    // ever revisits a state, fall back to the single worst violator per round,
    // which cannot cycle.
    const key = [...on].sort().join('|');
    if (seen.has(key)) oneAtATime = true;
    seen.add(key);
    const chosen = oneAtATime ? [flips.reduce((m, f) => (f.by > m.by ? f : m))] : flips;
    for (const f of chosen) {
      if (on.has(f.id)) on.delete(f.id);
      else on.add(f.id);
    }
    result = solveOnce();
    iterations++;
  }

  const voltages = new Map<string, number>();
  for (const node of nodes) if (!floating.has(node)) voltages.set(node, result.v(node));
  const currents = new Map<string, number>();
  const shorts: string[] = [];
  for (const e of elements) {
    const [p] = terminals(e);
    if (floating.has(p)) {
      currents.set(e.id, 0);
      continue;
    }
    if (e.kind === 'resistor') {
      currents.set(e.id, (result.v(e.a) - result.v(e.b)) / Math.max(MIN_OHMS, e.ohms));
    } else if (e.kind === 'source') {
      const terminal = result.v(e.plus) - result.v(e.minus);
      currents.set(e.id, (e.volts - terminal) / Math.max(MIN_OHMS, e.ohms));
      if (e.volts > 0 && terminal < e.volts / 2) shorts.push(e.id);
    } else {
      const across = result.v(e.anode) - result.v(e.cathode);
      currents.set(e.id, on.has(e.id) ? Math.max(0, (across - e.vf) / Math.max(MIN_OHMS, e.ohms)) : across * G_OFF);
    }
  }
  return { voltages, currents, floating, conducting: new Set(on), shorts, converged, iterations, singular: result.singular };
}
