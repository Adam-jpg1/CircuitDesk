import { useEffect, useState } from 'react';
import { navigate } from '../ui/primitives';
import { BackIcon, LogoIcon } from '../ui/icons';
import { fetchCompilerHealth } from '../compiler/compilerClient';
import type { CompilerHealth } from '../types';

export function AboutPage() {
  const [health, setHealth] = useState<CompilerHealth | null>(null);
  useEffect(() => {
    void fetchCompilerHealth().then(setHealth);
  }, []);

  return (
    <div className="dashboard">
      <header className="dash-header">
        <button className="icon-btn" onClick={() => navigate('#/')}><BackIcon /></button>
        <span className="dash-brand"><LogoIcon /> CircuitDesk <span className="tagline">About</span></span>
      </header>
      <div className="dash-body">
        <div className="doc-page">
          <h2 style={{ marginTop: 0 }}>CircuitDesk</h2>
          <p>
            CircuitDesk is a realistic electronics project workspace for planning, wiring, coding, validating,
            simulating, testing, and documenting hardware projects before physically assembling them.
          </p>

          <h2>The real simulation pipeline</h2>
          <p>
            Arduino C++ source → local toolchain (<code>arduino-cli</code> when installed, otherwise{' '}
            <code>avr-g++</code> with the Arduino AVR core) → compiled Intel HEX → <code>AVR8js</code> ATmega328P
            emulator → AVR port registers → Arduino pin mapping → circuit graph → component behavior → canvas.
          </p>
          <p>
            Nothing here scans your code for <code>digitalWrite</code> to fake an animation. If the LED blinks, it is
            because the compiled firmware toggled PORTB bit 5 inside a cycle-accurate emulator. Edit the{' '}
            <code>delay()</code> values and the blink timing changes accordingly. The serial monitor shows bytes
            transmitted by the emulated USART at your sketch's baud rate.
          </p>
          <p>
            Compiler status:{' '}
            {health === null ? 'checking…' : health.available ? (
              <strong style={{ color: 'var(--ok)' }}>{health.toolchain} — {health.version}</strong>
            ) : (
              <strong style={{ color: 'var(--warn)' }}>unavailable — {health.detail}</strong>
            )}
          </p>

          <h2>Honest support levels</h2>
          <p>Every board and component carries a badge that says what actually works:</p>
          <ul>
            <li><strong>Simulated</strong> — real firmware execution drives it (Arduino Uno, LEDs, buttons, potentiometers, buzzer, servo, 7-segment, HC-SR04, analog sensors).</li>
            <li><strong>Compile</strong> — code compiles for this target, but canvas simulation is limited (Arduino Nano).</li>
            <li><strong>Validation</strong> — wiring plus electrical rule checks (ESP32, Pico, I2C modules…).</li>
            <li><strong>Wiring</strong> — placeable with real pins and metadata, no deep checks yet.</li>
            <li><strong>Visual only</strong> — reference artwork (imported Gerbers, ESP32-CAM…).</li>
          </ul>
          <p>
            A board image never counts as board support here; unsupported boards are labeled as such rather than
            pretending to run firmware they can't.
          </p>

          <h2>What's real in the import center</h2>
          <ul>
            <li><strong>CircuitDesk JSON</strong> — full project restore with schema validation.</li>
            <li><strong>KiCad</strong> — s-expression parsing of <code>.kicad_pcb</code>: Edge.Cuts outline, footprints, pads, nets.</li>
            <li><strong>Eagle</strong> — XML parsing of boards/libraries: outline, elements, pads/SMDs, signals.</li>
            <li><strong>Fritzing</strong> — archive extraction, connector ids/names, SVG artwork, connector→SVG mapping.</li>
            <li><strong>EasyEDA</strong> — JSON structure detection, pads/tracks/components with coordinates.</li>
            <li><strong>Gerber + Excellon</strong> — aperture/draw/flash and drill parsing, rendered per-layer.</li>
            <li><strong>CSV / SVG / ZIP bundles</strong> — pin maps with column mapping, sanitized artwork, complete part bundles.</li>
          </ul>

          <h2>Local-first</h2>
          <p>
            Projects live in your browser's IndexedDB; the compile server runs on your machine. Export a{' '}
            <code>.cdproj.json</code> or ZIP package any time for backup or sharing.
          </p>

          <h2>Roadmap honesty</h2>
          <p>
            Analog (SPICE-class) simulation, ESP32/RP2040 emulation, and protocol decoding for I2C displays are
            planned adapter slots — they are marked as not implemented wherever they would appear, never faked.
          </p>
        </div>
      </div>
    </div>
  );
}
