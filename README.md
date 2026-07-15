# CircuitDesk

**CircuitDesk is a realistic electronics project workspace for planning, wiring, coding, validating, simulating, testing, and documenting hardware projects before physically assembling them.**

It is a desktop-first engineering application — not a mockup. The default Blink project compiles with a real
AVR toolchain and executes on a real ATmega328P emulator: if the compiled firmware sets D13 HIGH, the wired
LED turns on; change `delay(500)` to `delay(100)` and the blink rate actually changes.

Every board and part carries an honest support badge: **Simulated · Compile · Validation ·
Wiring · Visual only**. Nothing is labeled as working unless it actually works.

## The real simulation pipeline

```
Arduino C++ source
  → Arduino CLI (if installed) or avr-g++ + Arduino AVR core
  → compiled Intel HEX
  → AVR8js ATmega328P emulator (GPIO, timers/PWM, UART, ADC, interrupts)
  → AVR port state → Arduino pin mapping
  → circuit graph (nets from wires + breadboard internals)
  → component simulation (LEDs, buttons, pots, servo, buzzer, 7-segment, HC-SR04, analog sensors)
  → canvas visuals + serial monitor + pin states
```

No keyword scanning, no hardcoded animations — behavior comes from executing compiled firmware.

## Quick start

```bash
npm install
# toolchain for real compilation (Debian/Ubuntu):
sudo apt-get install gcc-avr avr-libc arduino-core-avr
# (alternatively install arduino-cli + `arduino-cli core install arduino:avr`;
#  the backend auto-detects arduino-cli and prefers it)

npm run dev          # starts the compile server (:3411) + Vite dev client (:5173)
```

Open http://localhost:5173, create the Blink starter project, press **Run** (Ctrl+Enter).

Production: `npm run build && npm start` (serves the built app + API on :3411).

## What's inside

| Area | What actually works |
|---|---|
| **Dashboard** | Create / open / rename / duplicate / delete / search / sort, recent project, thumbnails, 9 starter templates, empty states |
| **Editor** | IDE-style workspace; resizable + collapsible panels (sizes persist), infinite SVG canvas with grid/pan/zoom/fit, minimap, box-select, multi-select, rotate, snap, undo/redo, copy/paste, keyboard shortcuts, status bar |
| **Boards** | Detailed vector Arduino Uno (fully simulated); Nano (compile); Mega, Leonardo, Due, Uno R4, Nano 33 BLE, ESP32 family, ESP8266, Pico/Pico W, Pi GPIO headers, Teensy, micro:bit, STM32 Nucleo, Feather, QT Py, XIAO — with real pin metadata and honest wiring/validation badges |
| **Components** | Breadboards with real row/rail connectivity, LEDs, RGB LED, resistors (band colors from value), buttons, switches, pots, buzzer, servo, 7-segment, HC-SR04, TMP36, LDR, plus 20+ validation/wiring-level parts |
| **Wiring** | Pin-snapped wires (never attach to arbitrary pixels), wires follow moved parts, waypoints, smooth/orthogonal/straight routing, recoloring, labels, live signal highlighting, rich pin hover tooltips |
| **Code** | Monaco (bundled, offline), multiple files/tabs, compile diagnostics as markers, pin↔code cross-referencing |
| **Compiler** | Local Express backend: `arduino-cli` or `avr-g++` pipeline, cached core archive (~100 ms rebuilds), GCC diagnostics mapped back to `.ino` lines, memory usage, strict input validation, temp-dir isolation, timeouts, cleanup |
| **Simulation** | AVR8js: GPIO, timers, PWM (measured duty → LED brightness), UART both directions, ADC (pots/sensors feed real channels), ultrasonic echo protocol via CPU clock events, servo angle from measured pulse width; run/pause/step/reset/stop; execution speed readout |
| **Validation** | 20+ real rules: missing ground/power, LED resistor + polarity, 5V→3.3V conflicts, output shorts, GPIO over-current, floating inputs, I2C/UART pin checks, duplicate I2C devices, code↔circuit mismatches — each with severity, explanation, why-it-matters, suggested fix, click-to-highlight |
| **Test bench** | Automated tests on a fresh headless emulator: input events (press/toggle/pot/sensor) at scheduled times, assertions (pin becomes HIGH/LOW within, holds, toggles N×, serial contains), pass/fail with expected/actual and timeline |
| **Import** | Real parsers: CircuitDesk JSON (full restore), CSV pin maps (column mapping), KiCad `.kicad_pcb/.kicad_mod` (s-expressions: outline, footprints, pads, nets), Eagle `.brd/.sch/.lbr` (XML: elements, pads, signals), Fritzing `.fzz/.fzpz` (connectors + SVG mapping), EasyEDA JSON (pads/tracks/parts), Gerber+Excellon (aperture/draw/flash rendering with layer toggles), SVG board art, ZIP part bundles — via a 5-step wizard with graceful fallback to visual reference |
| **Custom parts** | Board creator: upload SVG/image, set physical size, click-to-place pins with full metadata, save to a cross-project library, edit and export |
| **Export** | `.cdproj.json`, ZIP package, BOM CSV, pin map CSV, wiring report, validation report, test report, board definition JSON, project image |
| **Persistence** | IndexedDB for projects and custom parts, localStorage for UI settings; autosave (debounced), refresh-safe |

## Architecture

```
src/
  app/                app shell, routes, editor store (undo/redo, autosave)
  dashboard/          project dashboard
  editor/             toolbar, library, inspector, bottom panels, Monaco
  canvas/             SVG canvas stage, geometry, wiring, minimap, thumbnails
  boards/             board definitions + Uno/module artwork
  components-library/ component definitions + vector artwork
  circuit/            circuit graph (union-find nets, breadboard internals)
  simulation/         AVR8js runner, circuit binding, controller, store
  compiler/           compile client + static code/pin analysis
  validation/         rule engine
  testing/            headless test runner
  import/             wizard + real format parsers + security hardening
  custom-parts/       custom board creator + library store
  project/            models, templates, persistence service, exporters
  persistence/        IndexedDB + settings
  types/ ui/ utils/
server/
  index.ts            Express API (+static hosting of dist/)
  compiler/           arduinoCli.ts · gccToolchain.ts · compilerService.ts · sketchBuilder.ts · fileService.ts
```

## Verification

```bash
npm run typecheck      # strict TS, client + server
npm run build          # production build
npm run test:pipeline  # compiles Blink via the API, executes it on AVR8js,
                       # asserts real 500ms timing, serial output, and that
                       # editing delay() changes behavior
npm run test:ui        # Playwright smoke test: dashboard → create project →
                       # editor → compile+run → serial output → persistence
                       # → no "Maximum update depth exceeded"
```

## Honest limitations (by design, clearly labeled in-app)

- Full firmware simulation currently covers the AVR/ATmega328P path (Uno). ESP32, RP2040, STM32 etc. are
  wiring/validation level — their badges say so, and the compiler returns a clear "unsupported board" error.
- Analog simulation is a digital-level circuit model (documented); a SPICE-class engine is an adapter slot,
  not a claim.
- I2C display protocol decoding (LCD/OLED pixels) is not implemented; those parts are validation-level.
