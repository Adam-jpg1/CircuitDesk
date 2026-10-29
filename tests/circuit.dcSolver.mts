// The DC solver on its own: no board, no canvas, no firmware.
//
// Each case is a circuit whose answer can be worked out by hand, and the
// solver has to agree with the hand calculation (an "ideal" 0 Ω source is
// given a milliohm, so those agree to about a part per million) — Ohm's law, dividers,
// diodes on and off, sources fighting, shorts and nets with nothing driving
// them.

import { solveDc, type CircuitElement } from '../src/circuit/dcSolver';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
const near = (a: number | undefined, b: number, tol: number) => a !== undefined && Math.abs(a - b) <= tol;
const mA = (a: number | undefined) => ((a ?? NaN) * 1000).toFixed(2);

const battery = (id: string, plus: string, minus: string, volts = 9, ohms = 1.5): CircuitElement => ({ kind: 'source', id, plus, minus, volts, ohms });
const R = (id: string, a: string, b: string, ohms: number): CircuitElement => ({ kind: 'resistor', id, a, b, ohms });
const LED = (id: string, anode: string, cathode: string, vf = 2.0): CircuitElement => ({ kind: 'diode', id, anode, cathode, vf, ohms: 15 });

console.log('\n--- Ohm\'s law');
{
  const s = solveDc([battery('b', 'p', 'n', 9, 0), R('r', 'p', 'n', 1000)]);
  check(near(s.currents.get('r'), 0.009, 1e-7), `9 V across 1 kΩ is 9 mA (${mA(s.currents.get('r'))} mA)`);
  check(near(s.voltages.get('n'), 0, 1e-12) && near(s.voltages.get('p'), 9, 1e-4), 'the minus terminal is the reference, the plus is at 9 V');
  check(near(s.currents.get('b'), 0.009, 1e-7), 'the source supplies the same current');
}

console.log('\n--- a divider');
{
  const s = solveDc([battery('b', 'p', 'n', 5, 0), R('r1', 'p', 'mid', 10_000), R('r2', 'mid', 'n', 4_700)]);
  check(near(s.voltages.get('mid'), (5 * 4700) / 14700, 1e-6), `10 k over 4.7 k from 5 V gives ${((5 * 4700) / 14700).toFixed(3)} V (${s.voltages.get('mid')?.toFixed(3)})`);
}

console.log('\n--- internal resistance');
{
  const s = solveDc([battery('b', 'p', 'n', 9, 1.5), R('r', 'p', 'n', 13.5)]);
  check(near(s.voltages.get('p'), 8.1, 1e-6), `a 1.5 Ω battery into 13.5 Ω sags to 8.1 V (${s.voltages.get('p')?.toFixed(3)})`);
  check(s.shorts.length === 0, 'which is a heavy load, not a short');
}

console.log('\n--- 9 V, 330 Ω, red LED');
{
  const s = solveDc([battery('b', 'p', 'n'), R('r', 'p', 'a', 330), LED('d', 'a', 'n')]);
  const i = s.currents.get('d') ?? 0;
  // (9 − 2.0) / (330 + 15 + 1.5) ≈ 20.2 mA
  check(near(i, 7 / 346.5, 1e-5), `about 20 mA flows (${mA(i)} mA)`);
  check(s.conducting.has('d'), 'the LED is conducting');
  check(near((s.voltages.get('a') ?? 0) - (s.voltages.get('n') ?? 0), 2 + i * 15, 1e-6), 'and drops its forward voltage plus its resistance');
  check(s.converged, `in ${s.iterations} iterations`);
}

console.log('\n--- the same LED reversed');
{
  const s = solveDc([battery('b', 'p', 'n'), R('r', 'p', 'k', 330), LED('d', 'n', 'k')]);
  check(!s.conducting.has('d'), 'reverse biased: it does not conduct');
  check(Math.abs(s.currents.get('d') ?? 1) < 1e-6, `only leakage flows (${((s.currents.get('d') ?? 0) * 1e9).toFixed(2)} nA)`);
}

console.log('\n--- no resistor');
{
  const s = solveDc([battery('b', 'p', 'n'), LED('d', 'p', 'n')]);
  const i = s.currents.get('d') ?? 0;
  check(i > 0.3, `the LED takes hundreds of milliamps, limited only by the battery and itself (${mA(i)} mA)`);
  check(Number.isFinite(i), 'and the number is finite');
}

console.log('\n--- a blue LED needs more voltage');
{
  const s = solveDc([battery('b', 'p', 'n', 3, 0.3), R('r', 'p', 'a', 100), LED('d', 'a', 'n', 3.0)]);
  check(!s.conducting.has('d'), '3 V cannot push a 3 V LED through a resistor past its knee... ');
  const s2 = solveDc([battery('b', 'p', 'n', 5, 0.1), R('r', 'p', 'a', 100), LED('d', 'a', 'n', 3.0)]);
  check(near(s2.currents.get('d'), 2 / 115.1, 1e-5), `...but 5 V does (${mA(s2.currents.get('d'))} mA)`);
}

console.log('\n--- diodes in series and in parallel');
{
  const s = solveDc([
    battery('b', 'p', 'n', 9, 0),
    R('r', 'p', 'x', 1000),
    { kind: 'diode', id: 'd1', anode: 'x', cathode: 'y', vf: 0.7, ohms: 0.5 },
    { kind: 'diode', id: 'd2', anode: 'y', cathode: 'n', vf: 0.7, ohms: 0.5 },
  ]);
  check(s.conducting.has('d1') && s.conducting.has('d2'), 'two diodes in series both conduct');
  check(near(s.voltages.get('x'), 1.4, 0.02), `and drop 1.4 V between them (${s.voltages.get('x')?.toFixed(3)})`);
  const p = solveDc([
    battery('b', 'p', 'n', 5, 0),
    R('r', 'p', 'x', 220),
    LED('red', 'x', 'n', 2.0),
    LED('blue', 'x', 'n', 3.0),
  ]);
  check(p.conducting.has('red') && !p.conducting.has('blue'), 'in parallel, the lower forward voltage takes it all — the blue stays dark');
}

console.log('\n--- an open circuit');
{
  const s = solveDc([battery('b', 'p', 'n'), R('r', 'p', 'a', 330), LED('d', 'a', 'k')]);
  check(Math.abs(s.currents.get('d') ?? 1) < 1e-6, 'with the loop broken, nothing flows');
  check(s.voltages.get('a') !== undefined && near(s.voltages.get('a'), 9, 0.01), 'and the open end sits at the battery voltage');
  check(s.converged && !s.singular, 'without a singular matrix');
}

console.log('\n--- a short across the battery');
{
  const s = solveDc([battery('b', 'p', 'n', 9, 1.5), R('wire', 'p', 'n', 0)]);
  check(s.shorts.includes('b'), 'is reported as a short');
  const i = s.currents.get('b') ?? 0;
  check(Number.isFinite(i) && near(i, 6, 0.01), `with the current the battery can actually push: 9 V / 1.5 Ω = 6 A (${i.toFixed(3)} A)`);
}

console.log('\n--- floating nets');
{
  const s = solveDc([battery('b', 'p', 'n'), R('r', 'p', 'n', 1000), R('lonely', 'x', 'y', 220), LED('d', 'y', 'z')]);
  check(s.floating.has('x') && s.floating.has('y') && s.floating.has('z'), 'a part with no source in its island floats');
  check(!s.voltages.has('x'), 'and has no voltage rather than a made-up zero');
  check(s.currents.get('lonely') === 0, 'and no current');
}

console.log('\n--- two islands, two references');
{
  const s = solveDc([
    battery('b1', 'p1', 'n1', 9, 0), R('r1', 'p1', 'n1', 900),
    battery('b2', 'p2', 'n2', 3, 0), R('r2', 'p2', 'n2', 300),
  ]);
  check(near(s.currents.get('r1'), 0.01, 1e-7) && near(s.currents.get('r2'), 0.01, 1e-7), 'each loop solves against its own minus terminal');
}

console.log('\n--- batteries in series');
{
  const s = solveDc([battery('b1', 'mid', 'n', 1.5, 0), battery('b2', 'p', 'mid', 1.5, 0), R('r', 'p', 'n', 300)]);
  check(near(s.currents.get('r'), 0.01, 1e-7), `two 1.5 V cells in series put 3 V across the load (${mA(s.currents.get('r'))} mA)`);
}

console.log('\n--- sources fighting');
{
  const s = solveDc([
    battery('high', 'x', 'g', 5, 30),
    battery('low', 'x', 'g', 0, 30),
  ], { groundNodes: ['g'] });
  check(near(s.voltages.get('x'), 2.5, 1e-6), `a pin driving high against one driving low settles between them (${s.voltages.get('x')?.toFixed(3)} V)`);
  check(near(s.currents.get('high'), 5 / 60, 1e-6), `with ${mA(s.currents.get('high'))} mA flowing from one into the other`);
}

console.log('\n--- the named ground is the reference');
{
  const s = solveDc([battery('b', 'p', 'n', 9, 0), R('r1', 'p', 'm', 1000), R('r2', 'm', 'n', 1000)], { groundNodes: ['m'] });
  check(near(s.voltages.get('m'), 0, 1e-12) && near(s.voltages.get('n'), -4.5, 1e-4), 'measured from a ground in the middle, the minus terminal is at −4.5 V');
}

console.log('\n--- an empty circuit');
{
  const s = solveDc([]);
  check(s.voltages.size === 0 && s.converged, 'solves to nothing without complaint');
}

console.log('\n--- a larger network stays fast');
{
  const els: CircuitElement[] = [battery('b', 'n0', 'gnd', 5, 0.1)];
  for (let i = 0; i < 120; i++) {
    els.push(R(`r${i}`, `n${i}`, `n${i + 1}`, 100));
    els.push(LED(`d${i}`, `n${i + 1}`, 'gnd', 1.8 + (i % 5) * 0.3));
  }
  const t0 = performance.now();
  const s = solveDc(els);
  const ms = performance.now() - t0;
  check(s.converged, `a 120-stage resistor/LED ladder converges (${s.iterations} iterations, ${ms.toFixed(1)} ms)`);
  check(ms < 500, 'quickly enough to run on every change');
}

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
