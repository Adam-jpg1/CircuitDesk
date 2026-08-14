# The analog layer, and how it will attach

**Status: not built. This is a design note, written now because eighteen parts
in the coverage matrix are waiting on it and the shape of the thing they are
waiting for should not be a surprise.**

Nothing here is implemented. No SPICE, no solver, no transient analysis. What
follows is how the analog layer will meet the code that already exists, so that
whoever builds it does not have to reverse-engineer the boundary first.

## Why this is the largest single blocker

From the coverage matrix, ranked by how many parts each missing primitive
holds up:

| Primitive | Parts waiting |
| --- | --- |
| `analog-solver` | 18 |
| `current-sensing` | 11 |
| `mechanical-load-model` | 7 |

`analog-solver` and `current-sensing` are the same project. Eleven of those
eleven need branch current, and branch current is what a nodal solver produces
on the way to node voltages. Building one gets both, and between them they
unblock capacitors, inductors, Zeners, op-amps, comparators, the 555, every
oscillator and filter, and honest load regulation on every supply and regulator
we ship.

## What exists today, and what it is not

The current engine is a **DC level propagator over a netlist**, not a solver.
`CircuitBinding.update()` resolves each net to a voltage once per settle:

- Sources contribute through `setLevel(netId, volts, sourcePin, seriesOhms)`.
- A stiffer source wins: lower `seriesOhms` overwrites higher.
- Two 0-ohm sources that disagree are recorded as a contention rather than
  averaged, because two output stages fighting is a fault and presenting it as
  a settled voltage would hide the most damaging wiring mistake a student can
  make.
- Declared rails contribute **zero volts and zero conductance**. A module's
  `VCC` pin is metadata; an unpowered module must not put 5 V on a net even
  through a megohm, because a high-impedance ADC input would read it.

Three properties of that design matter for what comes next:

1. **It is memoryless.** Each settle recomputes from scratch. There is no
   state carried between settles for any passive, which is exactly why a
   capacitor cannot be modelled today.
2. **It has no current.** `seriesOhms` orders sources by stiffness; it is not
   used to compute a current through anything.
3. **It is fast and it is called constantly** — once per `SimulationWorld`
   slice, which is once per simulated millisecond by default, alongside every
   device model on the canvas.

The last point is the constraint the analog layer has to respect.

## The shape of the addition

### A solver over a subgraph, not over the canvas

The whole netlist must not go through a matrix solve. A project with two boards,
a hundred digital parts and one RC filter should pay for the RC filter and
nothing else.

So: partition the netlist into **analog islands**. An island is a maximal set of
nets connected through components that require continuous treatment — passives
with state (C, L), controlled sources (op-amps, comparators), and non-linear
two-terminals (diodes, Zeners, BJTs, FETs in their analog regions). Everything
else stays on the existing propagator.

Islands meet the digital world at **boundary nets**, and there are only two
kinds of boundary:

- **Digital → analog**: an MCU pin driving into an island. It enters the solve
  as a Thévenin source (the pad's output voltage behind its output impedance,
  which the board profile already knows) or as an open circuit when the pad is
  an input.
- **Analog → digital**: an island net read by an MCU pin. Its solved voltage
  goes to `setDigitalInput` through the existing logic threshold, or to
  `setAnalogVolts` for an ADC channel — both of which the binding already does.

Nothing in the digital path changes. That is the point: the analog layer is a
second resolver for a subset of nets, and the existing code keeps its interface.

### Modified nodal analysis, companion models, backward Euler

The standard construction, chosen because it is standard:

- Build `G · v = i` per island, one row per node plus one per voltage source
  (MNA).
- Reactive elements enter as **companion models**: a capacitor over a timestep
  `h` becomes a conductance `C/h` in parallel with a current source carrying
  its previous voltage. An inductor is the dual. This is what makes the solve
  purely resistive at each step and is where the state that the current engine
  lacks will live.
- **Backward Euler** first, not trapezoidal. It is unconditionally stable and
  it damps rather than rings; trapezoidal's ringing on switching edges would
  produce artefacts that look like real oscillation, and a student cannot tell
  those apart from a design fault. Trapezoidal can come later behind a setting
  once there is something to compare against.
- Non-linear elements (diode, BJT, MOSFET) iterate with Newton-Raphson inside
  the timestep, with the usual damping and `gmin` stepping. A diode's existing
  behavioural model stays as the fallback when a part is not inside an island.

### Timestep, and its relationship to the world clock

`SimulationWorld` already keeps **integer nanoseconds** and already narrows a
slice to the next scheduled boundary. That was built for board-to-board UART
and it is precisely what the analog layer needs: an island with a 1 µs time
constant asks the world to stop at 1 µs, exactly as a microsecond event does
today.

- Each island proposes its own `nextEventNs` from its fastest time constant
  and its local truncation error.
- The world takes the minimum, as it already does.
- An island with nothing changing proposes nothing and costs nothing, so a
  settled RC network stops being work.

This is the mechanism that keeps a 555 running at 1 kHz from forcing the whole
canvas onto a nanosecond clock: only its island steps finely, and only while it
is switching.

### Current, and what it unblocks

Once MNA is solving, branch current is available for free, and `current-sensing`
stops being a separate project:

- **Regulators** can drop out under load instead of being ideal, which is what
  the eleven power parts are waiting for.
- **Motor drivers** can current-limit.
- **Fuses** can blow, which is the only thing that makes a fuse a component
  rather than a picture.
- **Batteries** can sag and deplete.
- The **relay coil** can have inrush, which combined with
  `contact-bounce-model` finishes the relay.

## The instruments, which are the reason to want this

Three parts in the matrix wait on `waveform-capture` and `probe-model`, and
they are the payoff rather than an afterthought:

- **Oscilloscope** — subscribes to a node and records `(t, v)` at the island's
  own timestep, not at the settle rate. The ring buffer belongs to the probe,
  not to the solver, so a scope on a fast island does not force the slow ones
  to keep history. Triggering is a predicate over the incoming stream.
- **Signal generator** — an independent voltage source with a time function.
  It enters MNA as an ordinary source whose value is evaluated at each `t`, and
  it proposes timesteps like any other reactive element so its edges are not
  stepped over. This is also `analog-waveform-source`, which the pulse sensor
  and the variable supply are waiting on.
- **Frequency counter** — a digital part, not an analog one: it counts edges on
  a boundary net through the existing pin-listener path. It should be built
  first, because it needs none of this.

The end state worth aiming at is being able to build an astable 555, put a
probe on the timing capacitor, and see the exponential charge between the two
thresholds — with the frequency matching the RC arithmetic on paper. That is
one concrete acceptance test, and it exercises the non-linear solve, the
companion models, the adaptive timestep and the probe at once.

## Order of work

1. **Frequency counter** — no solver needed, immediate value, proves the probe
   attachment point.
2. **Linear MNA with companion models** — R, C, L, independent sources. Ships
   the RC/RL transient, which is the single most requested missing behaviour.
3. **Island partitioning and adaptive timestep** — the performance work, done
   before non-linear parts make the solve expensive.
4. **Branch current exposed** — unblocks the eleven power parts without any new
   solver work.
5. **Non-linear two-terminals** — diode, Zener, LED I/V.
6. **Controlled sources** — op-amp, comparator; then the 555 falls out of the
   comparators plus the existing digital latch.
7. **Instruments** — oscilloscope and signal generator on top.

## What must not happen

- **The digital path must not slow down.** A project with no analog island must
  execute exactly as it does today. If the solver ends up in the hot path for
  everyone, the design is wrong.
- **No fabricated numbers in the meantime.** Until this exists, a part that
  needs it stays honest about it. That is what the blocker names in the
  coverage matrix are for, and adding a plausible-looking capacitor curve
  before there is a solver behind it would be worse than the current gap,
  because a gap is visible and a wrong number is not.
- **Do not start this during a component or artwork milestone.** It is its own
  project and it will take the whole of one.
