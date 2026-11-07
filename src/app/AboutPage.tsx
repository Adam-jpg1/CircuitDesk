import { useEffect, useState } from 'react';
import { navigate } from '../ui/primitives';
import { BackIcon, LogoIcon } from '../ui/icons';
import { fetchCompilerHealth } from '../compiler/compilerClient';
import { APP_VERSION_LABEL } from '../version';
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
          <h2 style={{ marginTop: 0 }}>CircuitDesk <span className="badge compile">{APP_VERSION_LABEL}</span></h2>
          <p>
            CircuitDesk is a realistic electronics project workspace for planning, wiring, coding, validating,
            simulating, testing, and documenting hardware projects before physically assembling them.
          </p>

          <h2>Simulation Pipeline</h2>
          <p>
            Your sketch is compiled with <code>arduino-cli</code> for the board you picked, and the firmware runs on a
            simulated copy of that board's chip (Raspberry Pi boards run Python instead). The pins it drives move the parts on the canvas, and the serial
            monitor shows what the sketch sends.
          </p>
          <p>
            If an LED blinks, the compiled firmware switched its pin. Change the <code>delay()</code> values and the
            blink changes with them.
          </p>
          <p>
            Compiler status:{' '}
            {health === null ? 'checking…' : health.available ? (
              <strong style={{ color: 'var(--ok)' }}>{health.toolchain} {health.version}</strong>
            ) : (
              <strong style={{ color: 'var(--warn)' }}>unavailable ({health.detail})</strong>
            )}
          </p>

          <h2>Support levels</h2>
          <p>Every board and component carries a badge that says what works:</p>
          <ul>
            <li><strong>Simulated</strong>: the compiled firmware runs and drives it. Every board in the library is simulated, along with LEDs, buttons, sensors, displays, motors and the other parts marked this way.</li>
            <li><strong>Compile</strong>: code compiles for the real target, but CircuitDesk cannot run it.</li>
            <li><strong>Validation</strong>: wiring plus electrical rule checks.</li>
            <li><strong>Wiring</strong>: placeable with real pins and metadata, no deeper checks yet.</li>
            <li><strong>Visual only</strong>: reference artwork, such as imported Gerbers.</li>
          </ul>

          <h2>External imports</h2>
          <ul>
            <li><strong>CircuitDesk JSON</strong>: full project restore with schema validation.</li>
            <li><strong>KiCad</strong>: <code>.kicad_pcb</code> outline, footprints, pads and nets.</li>
            <li><strong>Eagle</strong>: board and library outline, elements, pads and signals.</li>
            <li><strong>Fritzing</strong>: connector names, SVG artwork and how they map to each other.</li>
            <li><strong>EasyEDA</strong>: pads, tracks and components with coordinates.</li>
            <li><strong>Gerber + Excellon</strong>: copper, outline and drill layers, drawn per layer.</li>
            <li><strong>CSV / SVG / ZIP bundles</strong>: pin maps, sanitized artwork and complete part bundles.</li>
          </ul>

          <h2>Your projects</h2>
          <p>
            Projects are saved in your browser. Export a <code>.cdproj.json</code> or ZIP package any time to back up
            or share one.
          </p>

          <h2>Roadmap</h2>
          <p>
            Analog (SPICE-class) simulation and protocol decoding for I2C displays are planned adapter slots. They are
            marked as not implemented wherever they would appear.
          </p>
        </div>
      </div>
    </div>
  );
}
