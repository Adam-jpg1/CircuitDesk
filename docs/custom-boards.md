# Custom boards

A user should not have to wait for CircuitDesk to officially add their board.

This document is the reference for how that works: what the pieces are, why
they are separate, and what is guaranteed about a board CircuitDesk has never
seen.

## Four things, not one

The mistake this design exists to avoid is treating "board" as a single
concept. It is four, and they change independently:

| Concept | What it is | Where it lives |
|---|---|---|
| **Board identity** | The name, maker, outline, artwork and physical pins printed on a piece of hardware | `src/custom-boards/schema.ts` |
| **Processor** | What the chip has: pads, ADC channels, PWM pads, bus controllers, what is not modelled | `src/boards/processorProfiles.ts` |
| **Compile target** | Which toolchain builds for that chip, with which FQBN and artifact format | `src/boards/pipelineProfiles.ts` |
| **Simulation runtime** | Which emulator executes that chip's firmware, and what it actually models | `src/boards/pipelineProfiles.ts` |

An RP2040 is an RP2040 whether it is on a Raspberry Pi Pico, on a board
somebody designed last week, or on a board that does not exist yet. Splitting
these four apart is what lets a new board reuse everything CircuitDesk already
knows without inheriting another product's identity.

The three profile registries are shared by native and custom boards alike.
There is no custom-board branch anywhere in validation, compilation or
execution — a native board and a custom board reach the same code by the same
route.

## Physical pin ↔ processor pad

A pin has three names and they are not interchangeable:

- **`id`** — the identity wires are stored against. Never changes; renaming a
  board or a pin label does not move a single wire.
- **`label`** — what the maker printed on the silkscreen. What the canvas shows.
- **`pad`** — the processor pad it reaches, e.g. `GP15`, `PB5`, `IO23`.

Firmware is written against the pad, because that is what `digitalWrite(15)`
means. The user wires to the label, because that is what is in front of them.
Both are true at once, and keeping them attached is the whole mechanism:

```
pin STATUS_LED  →  pad GP15  →  runner index 15  →  the emulator's GPIO 15
```

The pad also becomes an alias of the pin, so a sketch or an import written
against `GP15` finds the pin whose label is `STATUS`.

On AVR the runner index is the *core's* pin number rather than the pad, because
that is the numbering the firmware was compiled with. `PB5` is 13 on an Uno,
`PB7` is 13 on a Mega, `PC7` is 13 on a Leonardo — three different pads, one
sketch, and the variant the board compiles for decides which.

## What a board may and may not claim

Capability is **derived**, never declared. A board file can choose a processor,
a compile profile and a runtime profile; what those choose is not up to it.

```
supportLevel = simulated  ⟺  a toolchain builds for this processor
                          ∧  an emulator runs this processor
                          ∧  the emulator accepts what the toolchain emits
```

A board that names the ESP32-C6 runtime inherits the C6's silence about UART,
ADC and PWM, and cannot talk its way out of it. A board with no processor is
wiring-only — a real, usable, saveable kind of board, not a failure state — and
it is never compiled as something else.

This is enforced in three places, because a project file is untrusted in
exactly the way a board file is:

1. `validateCustomBoard` builds a new object out of known fields rather than
   filtering a supplied one, so an invented field cannot survive.
2. `resolveCustomBoard` computes `supportLevel`, `compiler` and `simulation`
   from the profiles, discarding anything the file said.
3. `revalidateEmbeddedBoards` re-derives all of it every time a project is
   opened. A description that no longer validates keeps its geometry and its
   wires and loses every claim.

## The compile fingerprint

One definition of build identity, in `src/compiler/fingerprint.ts`.

**In:** compile profile and its revision, adapter, processor, FQBN, build flags,
toolchain versions, libraries, source bytes.

**Out:** name, artwork, colour, dimensions, position, instance id, pin labels.

Runtime is deliberately absent — whether an artifact can be *executed* is a
separate question, asked by `checkArtifactRuntime()`. An artifact is valid for
any board with the same build identity, which is why ten instances of one board
running one sketch is one compile.

## Build targets

A board may ask for a target other than its pipeline's default — an RP2040
board that wants the Pico W variant, a 328P board that wants the Nano's
bootloader. Every entry must be the **same chip**, because firmware for another
chip is firmware the runtime cannot execute.

The request passes four gates on the server (`resolveRequestedFqbn`):

1. **Shape** — three colon-separated names of a restricted alphabet, nothing
   else. No board options, no separators, no whitespace.
2. **Membership** — a target of the pinned core manifest, the same list the
   image bootstrap obeyed.
3. **Same chip** — not merely the same core. An Uno asking for a Mega build is
   refused.
4. **Refusal, not repair** — a rejected target is an error naming what was
   allowed, never a silent fall back to the default.

Nothing is escaped, because nothing is interpolated: `arduino-cli` is invoked
through `execFile` with an argument array and a shell is never involved.

## Security

A `.cdboard.json` is untrusted input. It cannot:

- execute anything — there is no field for a command, a hook, a module or a
  script, and neither the validator nor the resolver contains `eval`,
  `new Function` or a dynamic `import`;
- choose what the compiler service runs — the service resolves an allowlisted
  target and gates any override as above;
- inject script through artwork — SVG is rebuilt from an allowlist of drawing
  elements and attributes rather than filtered by a denylist, external
  references are dropped, and artwork is rendered through a `data:` URL in an
  `<image>` element where scripts are inert regardless;
- read or name anything on a machine — nothing in the custom-board path opens a
  file or a socket, and an export warns about paths on the way *out*, where the
  author can still fix it;
- exceed its bounds — 256 pins, 512 KB of artwork, 400 mm a side, bounded
  strings and arrays, and an oversized file rejected on length before parsing.

`tests/customBoard.security.mts` holds each of these.

## Revisions

The **id never changes**: it is what board instances reference, and changing it
would orphan every one of them. The **revision** increments when the definition
genuinely differs — saving a board you opened and did not edit is not a new
revision of it.

A definition's own revision number is never believed. A hand-edited file
claiming revision 99 does not get to win every future comparison.

The copy inside a project is a **snapshot**. Editing a board in the library
never silently reroutes wires in something already built with it; upgrading is
a thing the user chooses, and `previewUpgrade` prices it first — which pins go,
and which wires go with them.

## The Board Studio

`src/board-studio/`. Ten steps, most of them one question. The rules live in
`studioStore.ts` rather than in the components, so they can be tested without a
browser.

- **Simple mode** is not a cut-down Studio; it is the same flow with the two
  steps that have a correct answer already applied (artwork is optional, the
  pipeline follows the processor). Both remain reachable.
- **The capability readout is on screen the whole way through**, not summarised
  at the end. Watching "Wiring only" become "Simulated" the moment a chip is
  named is how a user learns what naming the chip was for.
- **The processor is never guessed.** An import offers a suggestion with the
  evidence it came from and a button; the button is the only thing that applies
  it.
- **Rows a pin map cannot read are listed with their row numbers.** Importing
  forty pins and receiving thirty-eight in silence is the failure this prevents.

## Importing

`IMPORT_CAPABILITIES` in `src/custom-boards/importCapabilities.ts` classifies
every format by what it genuinely produces — `complete`, `pins-geometry`,
`artwork-only`, `visual-only` — and the Studio shows that classification
*before* a file is chosen. A format that cannot carry pin semantics says so
rather than being discovered to be useless.

## Files

| Path | What it is |
|---|---|
| `src/custom-boards/schema.ts` | The definition and its limits |
| `src/custom-boards/validate.ts` | Every problem in a definition, at once |
| `src/custom-boards/resolve.ts` | Definition → `BoardDefinition` the rest of the app understands |
| `src/custom-boards/svgSanitize.ts` | Allowlist rebuild of board artwork |
| `src/custom-boards/bundle.ts` | `.cdboard.json` in and out |
| `src/custom-boards/import.ts` | Pin maps, processor suggestions, board assembly |
| `src/custom-boards/projectBoards.ts` | Embedding, revisions, upgrades, re-derivation |
| `src/board-studio/` | The Studio, its store and its board library |
| `src/boards/busProfile.ts` | Which pins can carry which bus line, on any board |

## Tests

```bash
npx tsx tests/customBoard.schema.mts        # the definition and its limits
npx tsx tests/customBoard.import.mts        # pin maps, suggestions, bundles
npx tsx tests/customBoard.busValidation.mts # bus advice in the maker's pin names
npx tsx tests/customBoard.acceptance.mts    # five chips, built and executed
npx tsx tests/customBoard.multiboard.mts    # twins, natives, a device on the bus
npx tsx tests/customBoard.portability.mts   # projects that open somewhere else
npx tsx tests/customBoard.security.mts      # what a board file cannot do
npx tsx tests/customBoard.performance.mts   # the tripwires
npx tsx tests/customBoard.demos.mts         # five end-to-end journeys
npx tsx tests/boardStudio.flow.mts          # the Studio's rules, headless
npx tsx tests/boardStudio.ui.mts            # the Studio in a browser
```
