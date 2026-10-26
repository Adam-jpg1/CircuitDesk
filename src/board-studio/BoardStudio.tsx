// The Board Studio.
//
// Ten steps, most of them one question, and the answer to the ones that have a
// correct answer already filled in. The point is not the wizard; it is that a
// person who has a board on their desk and no idea what an FQBN is can get that
// board onto the canvas, and that at no point does CircuitDesk claim something
// about it that is not true.
//
// The capability panel is on screen the whole way through for exactly that
// reason. It is not a summary at the end — it is a live readout of what the
// board can do given what has been said so far, so "wiring only" turning into
// "simulated" the moment a chip is chosen is something the user watches happen
// rather than something they are told afterwards.

import { useEffect, useRef, useState } from 'react';
import { useStudioStore, stepsFor, STEP_TITLE, draftCapability, type StudioStep } from './studioStore';
import { PinPlacementEditor } from './PinPlacementEditor';
import { libraryEntryFor } from './boardLibrary';
import { useCustomPartsStore } from '../custom-parts/customPartsStore';
import { useEditorStore } from '../app/editorStore';
import { embedBoard, embeddedBoards, previewUpgrade, upgradeEmbeddedBoard } from '../custom-boards/projectBoards';
import { exportBoardBundle, bundleFileName } from '../custom-boards/bundle';
import { PROCESSOR_PROFILES } from '../boards/processorProfiles';
import { COMPILE_PROFILES, RUNTIME_PROFILES } from '../boards/pipelineProfiles';
import { IMPORT_CAPABILITIES, capabilityLabel } from '../custom-boards/importCapabilities';
import { isError } from '../custom-boards/validate';
import { CUSTOM_BOARD_LIMITS } from '../custom-boards/schema';

export function BoardStudio() {
  const open = useStudioStore((s) => s.open);
  if (!open) return null;
  return <StudioBody />;
}

function StudioBody() {
  const mode = useStudioStore((s) => s.mode);
  const step = useStudioStore((s) => s.step);
  const draft = useStudioStore((s) => s.draft);
  const steps = stepsFor(mode);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useStudioStore.getState().close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="studio-backdrop" data-testid="board-studio">
      <div className="studio">
        <header className="studio-head">
          <div>
            <h2>Board Studio</h2>
            <p className="studio-muted">
              {draft ? `${draft.identity.name} — revision ${draft.revision}` : 'Bring in a board CircuitDesk does not have.'}
            </p>
          </div>
          <div className="studio-modes">
            <button
              className={`btn sm ${mode === 'simple' ? 'primary' : ''}`}
              onClick={() => useStudioStore.getState().setMode('simple')}
              data-testid="studio-mode-simple"
            >
              Simple
            </button>
            <button
              className={`btn sm ${mode === 'advanced' ? 'primary' : ''}`}
              onClick={() => useStudioStore.getState().setMode('advanced')}
              data-testid="studio-mode-advanced"
            >
              Advanced
            </button>
            <button className="btn sm" onClick={() => useStudioStore.getState().close()} data-testid="studio-close">
              Close
            </button>
          </div>
        </header>

        <nav className="wizard-steps studio-steps">
          {steps.map((s, i) => (
            <button
              key={s}
              className={`wizard-step ${s === step ? 'active' : ''} ${steps.indexOf(step) > i ? 'done' : ''}`}
              onClick={() => useStudioStore.getState().goTo(s)}
              data-testid={`studio-step-${s}`}
            >
              <span className="num">{i + 1}</span>
              {STEP_TITLE[s]}
            </button>
          ))}
        </nav>

        <div className="studio-body">
          <div className="studio-main" data-testid={`studio-pane-${step}`}>
            <StepPane step={step} />
          </div>
          <aside className="studio-side">
            <CapabilityPanel />
            <ProblemsPanel />
            <NotesPanel />
          </aside>
        </div>

        <footer className="studio-foot">
          <button className="btn" onClick={() => useStudioStore.getState().back()} disabled={steps.indexOf(step) === 0}>
            Back
          </button>
          <span className="spacer" />
          <SaveControls />
          <button
            className="btn primary"
            onClick={() => useStudioStore.getState().next()}
            disabled={steps.indexOf(step) === steps.length - 1}
            data-testid="studio-next"
          >
            Next
          </button>
        </footer>
      </div>
    </div>
  );
}

function StepPane({ step }: { step: StudioStep }) {
  switch (step) {
    case 'start': return <StartStep />;
    case 'identity': return <IdentityStep />;
    case 'outline': return <OutlineStep />;
    case 'artwork': return <ArtworkStep />;
    case 'processor': return <ProcessorStep />;
    case 'pins': return <PinsStep />;
    case 'placement': return <PinPlacementEditor />;
    case 'pipeline': return <PipelineStep />;
    case 'review': return <ReviewStep />;
  }
}

// ------------------------------------------------------------------- steps

function StartStep() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="studio-step-body">
      <h3>Where does this board come from?</h3>
      <div className="studio-choices">
        <button className="studio-choice" onClick={() => useStudioStore.getState().openNew('My board')} data-testid="studio-start-blank">
          <strong>Start from nothing</strong>
          <span>Name it, say how big it is, add its pins. Ten minutes for a board with a header on each side.</span>
        </button>
        <button className="studio-choice" onClick={() => fileRef.current?.click()} data-testid="studio-start-file">
          <strong>Open a board file</strong>
          <span>A <code>.cdboard.json</code> somebody sent you. Everything comes across.</span>
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".json,.cdboard.json,application/json"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const ok = useStudioStore.getState().openBundle(await file.text());
          setMessage(ok ? null : 'That file could not be opened as a board — the reasons are on the right.');
          e.target.value = '';
        }}
      />
      {message && <p className="studio-warn">{message}</p>}

      <h3 style={{ marginTop: 26 }}>What each format gives you</h3>
      <p className="studio-muted">
        Stated before you pick a file rather than discovered after. A format that cannot carry pins says so here.
      </p>
      <table className="kv-table">
        <thead><tr><th>Format</th><th>You get</th><th>What it cannot give</th></tr></thead>
        <tbody>
          {IMPORT_CAPABILITIES.map((c) => (
            <tr key={c.format}>
              <td>
                {c.name}
                <span className="badge">{capabilityLabel(c.level)}</span>
              </td>
              <td>{c.produces}</td>
              <td className="studio-muted">{c.limitation ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IdentityStep() {
  const draft = useStudioStore((s) => s.draft);
  if (!draft) return <NoDraft />;
  return (
    <div className="studio-step-body">
      <h3>What is it called?</h3>
      <p className="studio-muted">
        The name on the board, not a category. It is what the canvas, the build report and any error message will use.
      </p>
      <label className="studio-field">
        <span>Name</span>
        <input
          value={draft.identity.name}
          maxLength={CUSTOM_BOARD_LIMITS.maxNameLength}
          data-testid="studio-name"
          onChange={(e) => useStudioStore.getState().setIdentity({ name: e.target.value })}
        />
      </label>
      <label className="studio-field">
        <span>Who made it</span>
        <input
          value={draft.identity.creator ?? ''}
          placeholder="Optional — the maker, if it is not you"
          onChange={(e) => useStudioStore.getState().setIdentity({ creator: e.target.value })}
        />
      </label>
      <label className="studio-field">
        <span>Hardware version</span>
        <input
          value={draft.identity.hardwareVersion ?? ''}
          placeholder="Optional — “Rev C”, the version printed on the board"
          onChange={(e) => useStudioStore.getState().setIdentity({ hardwareVersion: e.target.value })}
        />
      </label>
      <label className="studio-field">
        <span>What it is</span>
        <textarea
          rows={3}
          value={draft.identity.description ?? ''}
          maxLength={CUSTOM_BOARD_LIMITS.maxDescriptionLength}
          placeholder="Optional. One line is plenty."
          onChange={(e) => useStudioStore.getState().setIdentity({ description: e.target.value })}
        />
      </label>
    </div>
  );
}

function OutlineStep() {
  const draft = useStudioStore((s) => s.draft);
  if (!draft) return <NoDraft />;
  return (
    <div className="studio-step-body">
      <h3>How big is it?</h3>
      <p className="studio-muted">
        Millimetres, measured across the board. Everything on the canvas is drawn to scale, so this is what makes your
        board the right size next to a breadboard.
      </p>
      <div className="studio-row">
        <label className="studio-field">
          <span>Width (mm)</span>
          <input
            type="number"
            min={CUSTOM_BOARD_LIMITS.minBoardMm}
            max={CUSTOM_BOARD_LIMITS.maxBoardMm}
            value={draft.outline.widthMm}
            data-testid="studio-width"
            onChange={(e) => useStudioStore.getState().setOutline({ widthMm: Number(e.target.value) })}
          />
        </label>
        <label className="studio-field">
          <span>Height (mm)</span>
          <input
            type="number"
            min={CUSTOM_BOARD_LIMITS.minBoardMm}
            max={CUSTOM_BOARD_LIMITS.maxBoardMm}
            value={draft.outline.heightMm}
            data-testid="studio-height"
            onChange={(e) => useStudioStore.getState().setOutline({ heightMm: Number(e.target.value) })}
          />
        </label>
        <label className="studio-field">
          <span>Solder mask colour</span>
          <input
            type="color"
            value={draft.outline.color ?? '#1e3a5f'}
            onChange={(e) => useStudioStore.getState().setOutline({ color: e.target.value })}
          />
        </label>
      </div>
      <p className="studio-muted">
        Between {CUSTOM_BOARD_LIMITS.minBoardMm} mm and {CUSTOM_BOARD_LIMITS.maxBoardMm} mm on each side.
      </p>
    </div>
  );
}

function ArtworkStep() {
  const draft = useStudioStore((s) => s.draft);
  const [message, setMessage] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  if (!draft) return <NoDraft />;

  const take = async (file: File) => {
    const result = useStudioStore.getState().setArtwork(await file.text());
    setMessage(result.message);
  };

  return (
    <div className="studio-step-body">
      <h3>What does it look like?</h3>
      <p className="studio-muted">
        Optional. Without artwork the board is drawn as a plain PCB with its pins and its name on it, which is a
        perfectly good board. With an SVG it looks like yours.
      </p>
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        data-testid="studio-artwork-drop"
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void take(file);
        }}
      >
        Drop an SVG here, or click to choose one.
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".svg,image/svg+xml"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void take(file);
          e.target.value = '';
        }}
      />
      {message && <p className={message.startsWith('That file was refused') ? 'studio-warn' : 'studio-muted'}>{message}</p>}
      <p className="studio-muted">
        Artwork is rebuilt from an allowlist of drawing instructions before it is stored: shapes, paths, text and
        gradients survive; scripts, external references and anything that could load something do not. That is why a
        file may come back with parts removed — and why the parts that were removed are listed rather than dropped
        quietly.
      </p>
      {draft.outline.artworkSvg && (
        <div className="studio-row" style={{ alignItems: 'center' }}>
          <span className="studio-muted">
            Artwork stored ({Math.round(draft.outline.artworkSvg.length / 1024)} KB of a{' '}
            {Math.round(CUSTOM_BOARD_LIMITS.maxArtworkBytes / 1024)} KB limit).
          </span>
          <button className="btn sm" onClick={() => useStudioStore.getState().clearArtwork()}>Remove artwork</button>
        </div>
      )}
    </div>
  );
}

function ProcessorStep() {
  const draft = useStudioStore((s) => s.draft);
  const suggestions = useStudioStore((s) => s.suggestions);
  if (!draft) return <NoDraft />;

  return (
    <div className="studio-step-body">
      <h3>What chip is on it?</h3>
      <p className="studio-muted">
        This is the one question nothing can answer for you, and the one CircuitDesk will never guess. Everything that
        follows — what compiles, what runs, which pads your pins can reach — comes from this answer.
      </p>

      {suggestions.length > 0 && (
        <div className="studio-suggest" data-testid="studio-suggestions">
          <strong>The file you imported suggests:</strong>
          {suggestions.map((s) => {
            const profile = PROCESSOR_PROFILES.find((p) => p.id === s.processorProfileId);
            return (
              <div key={s.processorProfileId} className="studio-suggest-row">
                <span>
                  {profile?.name ?? s.processorProfileId} — {s.evidence}{' '}
                  <span className="badge">{s.confidence}</span>
                </span>
                <button className="btn sm" onClick={() => useStudioStore.getState().setProcessor(s.processorProfileId)}>
                  Use this
                </button>
              </div>
            );
          })}
          <p className="studio-muted">
            A suggestion, not a decision — nothing is applied until you press it.
          </p>
        </div>
      )}

      <div className="studio-choices">
        <button
          className={`studio-choice ${draft.processorProfileId === null ? 'chosen' : ''}`}
          onClick={() => useStudioStore.getState().setProcessor(null)}
          data-testid="studio-processor-none"
        >
          <strong>No processor</strong>
          <span>
            A breakout, a shield, a passive board. It wires and validates; nothing compiles for it and nothing runs on
            it, and CircuitDesk will say so rather than build it as something else.
          </span>
        </button>
        {PROCESSOR_PROFILES.map((p) => (
          <button
            key={p.id}
            className={`studio-choice ${draft.processorProfileId === p.id ? 'chosen' : ''}`}
            onClick={() => useStudioStore.getState().setProcessor(p.id)}
            data-testid={`studio-processor-${p.id}`}
          >
            <strong>{p.name}</strong>
            <span>
              {p.vendor} · {p.pads.length} pads · {(p.clockHz / 1_000_000).toFixed(0)} MHz ·{' '}
              {Math.round(p.flashBytes / 1024)} KB flash · {p.logicVolts} V logic
            </span>
            <span className="studio-muted">Not modelled: {p.notModelled.join('; ')}.</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PinsStep() {
  const draft = useStudioStore((s) => s.draft);
  const [rows, setRows] = useState<{ row: number; message: string }[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  if (!draft) return <NoDraft />;

  const takeCsv = (text: string) => {
    const result = useStudioStore.getState().importPinCsv(text);
    setRows(result.errors);
    setSummary(`${result.added} pin(s) read${result.errors.length ? `, ${result.errors.length} row(s) could not be read` : ''}.`);
  };

  return (
    <div className="studio-step-body">
      <h3>What pins does it have?</h3>
      <p className="studio-muted">
        A pin has a name you print on the board and — if there is a chip — the processor pad it reaches. Those are two
        different things on purpose: firmware is written against the pad, and you wire to the name.
      </p>

      <div className="studio-row">
        <button className="btn" onClick={() => useStudioStore.getState().addPin()} data-testid="studio-add-pin">
          Add a pin
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()} data-testid="studio-import-csv">
          Import a pin map (CSV)
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,text/csv,text/plain"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) takeCsv(await file.text());
            e.target.value = '';
          }}
        />
      </div>
      <p className="studio-muted">
        A label column on its own is enough. Add a processor-pin column to map pads, and x/y columns if your file has
        positions — otherwise you place them in the next step.
      </p>
      {summary && <p data-testid="studio-csv-summary">{summary}</p>}
      {rows.length > 0 && (
        <div className="studio-warn" data-testid="studio-csv-errors">
          <strong>Rows that could not be read:</strong>
          <ul>{rows.map((r) => <li key={r.row}>Row {r.row}: {r.message}</li>)}</ul>
        </div>
      )}

      <PinEditorTable />
    </div>
  );
}

function PinEditorTable() {
  const draft = useStudioStore((s) => s.draft);
  const processor = PROCESSOR_PROFILES.find((p) => p.id === draft?.processorProfileId);
  if (!draft) return null;

  return (
    <table className="kv-table" data-testid="studio-pin-table">
      <thead>
        <tr><th>Id</th><th>Label</th><th>Role</th><th>Processor pad</th><th /></tr>
      </thead>
      <tbody>
        {draft.pins.map((pin) => (
          <tr key={pin.id}>
            <td>
              <input
                value={pin.id}
                onChange={(e) => useStudioStore.getState().updatePin(pin.id, { id: e.target.value })}
              />
            </td>
            <td>
              <input
                value={pin.label}
                onChange={(e) => useStudioStore.getState().updatePin(pin.id, { label: e.target.value })}
              />
            </td>
            <td>
              <select
                value={pin.type}
                onChange={(e) => useStudioStore.getState().updatePin(pin.id, { type: e.target.value as typeof pin.type })}
              >
                {['digital', 'analog', 'power-5v', 'power-3v3', 'power-vin', 'ground', 'reset', 'aref', 'nc'].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </td>
            <td>
              {processor ? (
                <select
                  value={pin.pad ?? ''}
                  data-testid={`studio-pad-${pin.id}`}
                  onChange={(e) => useStudioStore.getState().updatePin(pin.id, { pad: e.target.value || null })}
                >
                  <option value="">— not connected to the chip —</option>
                  {processor.pads.map((pad) => <option key={pad} value={pad}>{pad}</option>)}
                </select>
              ) : (
                <span className="studio-muted">Choose a processor to map pads</span>
              )}
            </td>
            <td>
              <button className="btn sm" onClick={() => useStudioStore.getState().removePin(pin.id)}>Remove</button>
            </td>
          </tr>
        ))}
        {draft.pins.length === 0 && (
          <tr><td colSpan={5} className="studio-muted">No pins yet.</td></tr>
        )}
      </tbody>
    </table>
  );
}

function PipelineStep() {
  const draft = useStudioStore((s) => s.draft);
  const mismatches = useStudioStore((s) => s.mismatches);
  if (!draft) return <NoDraft />;
  const selected = COMPILE_PROFILES.find((c) => c.id === draft.compileProfileId);
  const compiles = COMPILE_PROFILES.filter(
    (c) => c.adapter === 'none' || !draft.processorProfileId || c.processorProfileIds.includes(draft.processorProfileId),
  );
  const others = COMPILE_PROFILES.filter((c) => !compiles.includes(c));

  return (
    <div className="studio-step-body">
      <h3>How is it built, and how is it run?</h3>
      <p className="studio-muted">
        Already answered by the chip you chose. Change it if your board needs a different target — and if the
        combination cannot work, it will say so rather than fail later inside a compiler.
      </p>

      <label className="studio-field">
        <span>Toolchain</span>
        <select
          value={draft.compileProfileId}
          data-testid="studio-compile-profile"
          onChange={(e) => useStudioStore.getState().setCompileProfile(e.target.value)}
        >
          <optgroup label="For this processor">
            {compiles.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </optgroup>
          {others.length > 0 && (
            <optgroup label="For other processors">
              {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </optgroup>
          )}
        </select>
      </label>

      <label className="studio-field">
        <span>Runtime</span>
        <select
          value={draft.runtimeProfileId}
          data-testid="studio-runtime-profile"
          onChange={(e) => useStudioStore.getState().setRuntimeProfile(e.target.value)}
        >
          {RUNTIME_PROFILES.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>

      <label className="studio-field">
        <span>Build target (FQBN)</span>
        <select
          value={draft.fqbnOverride ?? ''}
          data-testid="studio-fqbn"
          onChange={(e) => useStudioStore.getState().setFqbnOverride(e.target.value || undefined)}
        >
          <option value="">{selected?.fqbn ? `${selected.fqbn} (the toolchain's own target)` : 'none'}</option>
          {(selected?.alternateFqbns ?? []).map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </label>
      <p className="studio-muted">
        A list rather than a text box, and a short one: every entry is a target for the same chip, because a target for
        a different chip would produce firmware this board's runtime cannot execute. The compiler service checks the
        same rule again on its own side, and passes the value to the toolchain as an argument rather than as a command —
        an FQBN never reaches a shell.
      </p>

      {mismatches.length > 0 && (
        <div className="studio-warn" data-testid="studio-mismatches">
          <strong>This combination cannot work:</strong>
          <ul>{mismatches.map((m) => <li key={m.code}>{m.message}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function ReviewStep() {
  const draft = useStudioStore((s) => s.draft);
  if (!draft) return <NoDraft />;
  const capability = draftCapability(draft);

  return (
    <div className="studio-step-body">
      <h3>What this board can do</h3>
      <p className="studio-muted">
        Every line below is derived from the board, the chip, the toolchain and the runtime. None of it is typed in
        anywhere, which is why it can be trusted.
      </p>
      <table className="kv-table">
        <tbody>
          <tr><th>Board</th><td>{draft.identity.name}{draft.identity.creator ? ` — ${draft.identity.creator}` : ''}</td></tr>
          <tr><th>Size</th><td>{draft.outline.widthMm} × {draft.outline.heightMm} mm, {draft.pins.length} pins</td></tr>
          <tr><th>Processor</th><td>{capability?.processor}</td></tr>
          <tr><th>Compiles with</th><td>{capability?.compile}</td></tr>
          <tr><th>Runs on</th><td>{capability?.runtime}</td></tr>
          <tr>
            <th>Support level</th>
            <td data-testid="studio-support-level"><strong>{capability?.supportLevel}</strong></td>
          </tr>
          <tr>
            <th>Simulated</th>
            <td>{capability?.supported.length ? capability.supported.join(', ') : 'nothing — this board does not execute firmware'}</td>
          </tr>
          <tr><th>Not simulated</th><td>{capability?.notSimulated.join('; ')}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

function NoDraft() {
  return (
    <div className="studio-step-body">
      <h3>Nothing open</h3>
      <p className="studio-muted">Start a board from the first step, or open a board file.</p>
      <button className="btn primary" onClick={() => useStudioStore.getState().openNew('My board')}>Start a board</button>
    </div>
  );
}

// ------------------------------------------------------------- side panels

function CapabilityPanel() {
  const draft = useStudioStore((s) => s.draft);
  const capability = draftCapability(draft);
  if (!capability) return null;
  const level = capability.supportLevel;
  return (
    <section className="studio-card" data-testid="studio-capability">
      <h4>Right now, this board is</h4>
      <p className={`studio-level ${level}`} data-testid="studio-capability-level">
        {level === 'simulated' ? 'Simulated' : level === 'compile' ? 'Compiles only' : 'Wiring only'}
      </p>
      <p className="studio-muted">
        {level === 'simulated'
          ? 'Firmware is compiled and executed. Pins move, devices respond.'
          : level === 'compile'
            ? 'Firmware is compiled for it, but CircuitDesk has no emulator for this chip, so nothing executes.'
            : 'It wires and validates. Nothing is compiled for it and nothing runs on it.'}
      </p>
      <dl className="studio-dl">
        <dt>Processor</dt><dd>{capability.processor}</dd>
        <dt>Toolchain</dt><dd>{capability.compile}</dd>
        <dt>Runtime</dt><dd>{capability.runtime}</dd>
      </dl>
    </section>
  );
}

function ProblemsPanel() {
  const problems = useStudioStore((s) => s.problems);
  if (problems.length === 0) return null;
  return (
    <section className="studio-card" data-testid="studio-problems">
      <h4>{problems.filter(isError).length} to fix, {problems.filter((p) => !isError(p)).length} to know about</h4>
      <ul className="studio-problems">
        {problems.map((p, i) => (
          <li key={`${p.code}-${i}`} className={isError(p) ? 'err' : 'warn'}>
            <strong>{isError(p) ? 'Must fix' : 'Note'}</strong> {p.message}
            {p.pinId && <span className="studio-muted"> ({p.pinId})</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function NotesPanel() {
  const notes = useStudioStore((s) => s.notes);
  if (notes.length === 0) return null;
  return (
    <section className="studio-card">
      <h4>What happened</h4>
      <ul className="studio-problems">
        {notes.map((n, i) => (
          <li key={i} className={n.kind === 'warning' ? 'warn' : ''}>{n.text}</li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- saving

function SaveControls() {
  const draft = useStudioStore((s) => s.draft);
  const savedRevision = useStudioStore((s) => s.savedRevision);
  const problems = useStudioStore((s) => s.problems);
  const [message, setMessage] = useState<string | null>(null);
  const blocking = problems.filter(isError);

  const save = async () => {
    const ready = useStudioStore.getState().readyToSave();
    if (!ready) {
      setMessage('There is something to fix first — the list is on the right.');
      return;
    }
    const { entry, problems: entryProblems } = libraryEntryFor(ready);
    if (!entry) {
      setMessage(entryProblems[0]?.message ?? 'The board could not be saved.');
      return;
    }
    await useCustomPartsStore.getState().add(entry);
    useStudioStore.getState().markSaved(ready);
    setMessage(`Saved to My Boards as revision ${ready.revision}.`);
  };

  const addToProject = () => {
    const ready = useStudioStore.getState().readyToSave();
    const editor = useEditorStore.getState();
    if (!ready || !editor.project) {
      setMessage('There is something to fix first — the list is on the right.');
      return;
    }
    editor.mutateCircuit((p) => {
      embedBoard(p, ready);
    });
    const view = editor.view;
    editor.addInstance(ready.id, view.x + 320 / view.zoom, view.y + 200 / view.zoom);
    useStudioStore.getState().markSaved(ready);
    setMessage(`${ready.identity.name} is on the canvas. A copy of it travels with this project.`);
  };

  const exportBundle = () => {
    const ready = useStudioStore.getState().readyToSave();
    if (!ready) {
      setMessage('There is something to fix first — the list is on the right.');
      return;
    }
    const { json, problems: exportProblems } = exportBoardBundle(ready);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = bundleFileName(ready);
    a.click();
    URL.revokeObjectURL(url);
    setMessage(exportProblems[0]?.message ?? `Exported as ${bundleFileName(ready)}.`);
  };

  return (
    <div className="studio-save">
      {message && <span className="studio-muted" data-testid="studio-save-message">{message}</span>}
      <UpgradeControl onMessage={setMessage} />
      {savedRevision !== null && <span className="badge">revision {savedRevision} saved</span>}
      <button className="btn" onClick={exportBundle} disabled={!draft || blocking.length > 0} data-testid="studio-export">
        Export file
      </button>
      <button className="btn" onClick={() => void save()} disabled={!draft || blocking.length > 0} data-testid="studio-save">
        Save to My Boards
      </button>
      <button
        className="btn primary"
        onClick={addToProject}
        disabled={!draft || blocking.length > 0}
        data-testid="studio-add-to-project"
      >
        Add to this project
      </button>
    </div>
  );
}

/**
 * "This project is on an older revision of this board."
 *
 * The other half of revisioning, and the half that is easy to leave out: a
 * library edit deliberately does NOT reach into projects already built with the
 * board, so unless the user is offered the upgrade somewhere, the snapshot
 * becomes a trap rather than a protection.
 *
 * The cost is quoted before it is charged. Dropping a pin drops the wires on
 * it, and a person deciding whether to upgrade needs that number in front of
 * them, not afterwards.
 */
function UpgradeControl({ onMessage }: { onMessage: (m: string) => void }) {
  const draft = useStudioStore((s) => s.draft);
  const project = useEditorStore((s) => s.project);
  if (!draft || !project) return null;

  const embedded = embeddedBoards(project).get(draft.id);
  if (!embedded) return null;

  const ready = useStudioStore.getState().readyToSave();
  if (!ready || ready.revision === embedded.revision) {
    return <span className="badge" data-testid="studio-project-revision">project on revision {embedded.revision}</span>;
  }

  const cost = previewUpgrade(project, ready);
  const wires = cost?.droppedPins.reduce((n, d) => n + d.connectionIds.length, 0) ?? 0;
  const summary =
    cost && cost.droppedPins.length > 0
      ? `${cost.droppedPins.length} pin(s) go, taking ${wires} wire(s)`
      : 'nothing on the canvas is lost';

  return (
    <span className="studio-upgrade" data-testid="studio-upgrade">
      <span className="studio-muted">
        This project is on revision {embedded.revision}. Updating it to {ready.revision}: {summary}.
      </span>
      <button
        className="btn sm"
        data-testid="studio-upgrade-apply"
        onClick={() => {
          const editor = useEditorStore.getState();
          editor.mutateCircuit((p) => {
            upgradeEmbeddedBoard(p, ready);
          });
          // The quote above IS the cost — `previewUpgrade` and the upgrade walk
          // the same pins, which is the whole point of quoting it first. This
          // used to read the count back out of a variable assigned inside the
          // mutation callback, which TypeScript rightly refused to believe had
          // been assigned at all.
          const lost = wires;
          useStudioStore.getState().markSaved(ready);
          onMessage(
            `This project now uses revision ${ready.revision}` +
            (lost > 0 ? `, and ${lost} wire(s) were removed with the pins that went.` : '.'),
          );
        }}
      >
        Update in this project
      </button>
    </span>
  );
}
