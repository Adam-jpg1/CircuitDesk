import { useCallback, useMemo, useState } from 'react';
import { IMPORT_FORMATS, detectAndParse, autoMapCsvPins } from './importService';
import { ImportError, type ImportParseResult, type ImportedPin } from './types';
import { buildCustomDefinition, buildProjectFromImport, boardDefinitionForStudio, type ImportOptions } from './convert';
import { useStudioStore } from '../board-studio/studioStore';
import { saveProject, listProjectMetas, loadProject } from '../project/projectService';
import { useCustomPartsStore } from '../custom-parts/customPartsStore';
import { navigate, toast, SupportBadge } from '../ui/primitives';
import { LogoIcon, BackIcon, CheckIcon } from '../ui/icons';
import { PinPlacementEditor } from './PinPlacementEditor';
import { uid, type ProjectMeta, type SupportLevel } from '../types';

const STEPS = ['Upload', 'Parse', 'Mapping', 'Preview', 'Import'] as const;

export function ImportWizard() {
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportParseResult | null>(null);
  const [pins, setPins] = useState<ImportedPin[]>([]);
  const [options, setOptions] = useState<ImportOptions>({
    name: '',
    widthMm: 50,
    heightMm: 35,
    supportLevel: 'wiring',
    target: 'custom-board',
  });
  const [csvMapping, setCsvMapping] = useState<Record<string, number>>({});
  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>({});
  const [importing, setImporting] = useState(false);

  const runParse = useCallback(async (f: File) => {
    setParsing(true);
    setParseError(null);
    try {
      const r = await detectAndParse(f);
      setResult(r);
      setPins(r.pins ?? []);
      setOptions((o) => ({
        ...o,
        name: r.name,
        widthMm: r.outline?.widthMm ?? o.widthMm,
        heightMm: r.outline?.heightMm ?? o.heightMm,
        target: r.project ? 'new-project' : r.format === 'gerber' ? 'visual-reference' : 'custom-board',
        supportLevel: r.format === 'gerber' ? 'visual-only' : 'wiring',
      }));
      if (r.layers) setLayerVisibility(Object.fromEntries(r.layers.map((l) => [l.name, l.visible])));
      setStep(1);
    } catch (err) {
      console.error('[CircuitDesk] import parse failed:', err);
      setParseError(err instanceof ImportError || err instanceof Error ? err.message : 'Import failed.');
      setStep(1);
      setResult(null);
    } finally {
      setParsing(false);
    }
  }, []);

  const doImport = useCallback(async () => {
    // 'existing-project' has its own flow (importIntoExisting in the last step)
    if (!result || importing || options.target === 'existing-project') return;
    setImporting(true);
    try {
      const effectiveResult = result.layers
        ? { ...result, layers: result.layers.map((l) => ({ ...l, visible: layerVisibility[l.name] ?? l.visible })) }
        : result;
      if (options.target === 'new-project') {
        const project = buildProjectFromImport(effectiveResult, options, pins);
        project.name = options.name || project.name;
        await saveProject(project);
        toast(`Imported project “${project.name}”`, 'success');
        navigate(`#/editor/${project.id}`);
        return;
      }
      if (options.target === 'board-studio') {
        // Everything the parser genuinely found, handed to the Studio so the
        // user can say what chip is on it. No processor is guessed on the way:
        // a PCB file says where the copper is, not what is soldered to it.
        const draft = boardDefinitionForStudio(effectiveResult, options, pins);
        useStudioStore.getState().openImported(draft, effectiveResult.format);
        toast(`“${draft.identity.name}” is open in the Board Studio. Tell it what chip is on it.`, 'success');
        navigate('#/');
        return;
      }
      const custom = buildCustomDefinition(effectiveResult, options, pins);
      await useCustomPartsStore.getState().add(custom);
      toast(`Saved “${custom.definition.name}” to your ${custom.kind === 'board' ? 'custom board' : 'custom component'} library`, 'success');
      navigate('#/custom-parts');
    } catch (err) {
      console.error('[CircuitDesk] import failed:', err);
      toast(err instanceof Error ? err.message : 'Import failed: the file could not be converted.', 'error');
    } finally {
      setImporting(false);
    }
  }, [result, options, pins, layerVisibility, importing]);

  return (
    <div className="dashboard">
      <header className="dash-header">
        <button className="icon-btn" onClick={() => navigate('#/')}><BackIcon /></button>
        <span className="dash-brand"><LogoIcon /> CircuitDesk <span className="tagline">Import center</span></span>
      </header>
      <div className="wizard-steps">
        {STEPS.map((label, i) => (
          <span key={label} className={`wizard-step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}>
            <span className="num">{i < step ? '✓' : i + 1}</span> {label}
          </span>
        ))}
      </div>
      <div className="dash-body">
        {step === 0 && <UploadStep parsing={parsing} onFile={(f) => { setFile(f); void runParse(f); }} />}
        {step === 1 && (
          <ParseStep
            file={file}
            result={result}
            error={parseError}
            onBack={() => { setStep(0); setResult(null); setParseError(null); }}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && result && (
          <MappingStep
            result={result}
            pins={pins}
            setPins={setPins}
            options={options}
            setOptions={setOptions}
            csvMapping={csvMapping}
            setCsvMapping={setCsvMapping}
            layerVisibility={layerVisibility}
            setLayerVisibility={setLayerVisibility}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
          />
        )}
        {step === 3 && result && (
          <PreviewStep result={result} pins={pins} options={options} layerVisibility={layerVisibility} onBack={() => setStep(2)} onNext={() => setStep(4)} />
        )}
        {step === 4 && result && (
          <ImportStep result={result} pins={pins} options={options} setOptions={setOptions} importing={importing} onBack={() => setStep(3)} onImport={() => void doImport()} />
        )}
      </div>
    </div>
  );
}

function UploadStep({ onFile, parsing }: { onFile: (f: File) => void; parsing: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <div style={{ maxWidth: 860 }}>
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) onFile(f);
        }}
        onClick={() => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = IMPORT_FORMATS.flatMap((f) => f.extensions).join(',');
          input.onchange = () => input.files?.[0] && onFile(input.files[0]);
          input.click();
        }}
      >
        {parsing ? (
          <><div className="spinner" style={{ margin: '0 auto 10px' }} /> Parsing…</>
        ) : (
          <>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-0)' }}>Drop a file here or click to browse</div>
            <div style={{ marginTop: 6 }}>KiCad · Fritzing · Eagle · EasyEDA · Gerber · SVG · CSV pin map · CircuitDesk project · ZIP part bundle</div>
          </>
        )}
      </div>
      <div className="dash-section-title">Supported formats</div>
      <table className="kv-table">
        <thead><tr><th>Format</th><th>Extensions</th><th>What actually happens</th><th>Result</th></tr></thead>
        <tbody>
          {IMPORT_FORMATS.map((f) => (
            <tr key={f.id}>
              <td style={{ fontWeight: 600 }}>{f.name}</td>
              <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{f.extensions.join(' ')}</td>
              <td style={{ color: 'var(--text-1)' }}>{f.description}</td>
              <td style={{ color: 'var(--text-2)' }}>{f.capability}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ParseStep({ file, result, error, onBack, onNext }: {
  file: File | null;
  result: ImportParseResult | null;
  error: string | null;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div style={{ maxWidth: 760 }}>
      {file && (
        <div style={{ marginBottom: 14, color: 'var(--text-1)' }}>
          <strong>{file.name}</strong> · {(file.size / 1024).toFixed(1)} KB · detected type:{' '}
          <strong>{result ? IMPORT_FORMATS.find((f) => f.id === result.format)?.name ?? result.format : 'unknown'}</strong>
        </div>
      )}
      {error ? (
        <div className="issue-item" style={{ border: '1px solid #6e2724', borderRadius: 6 }}>
          <div>
            <div className="issue-title" style={{ color: '#ff8a80' }}>Parsing failed</div>
            <div className="issue-desc">{error}</div>
            <div className="issue-fix">
              If this is board artwork, you can still import it as an SVG visual reference and place pins manually.
            </div>
          </div>
        </div>
      ) : result ? (
        <>
          <table className="kv-table" style={{ maxWidth: 480 }}>
            <tbody>
              <tr><td>Name</td><td><strong>{result.name}</strong></td></tr>
              {result.outline && (
                <tr><td>Board outline</td><td>{result.outline.widthMm.toFixed(1)} × {result.outline.heightMm.toFixed(1)} mm</td></tr>
              )}
              {result.pins && <tr><td>Pins / pads</td><td>{result.pins.length}</td></tr>}
              {result.components && result.components.length > 0 && <tr><td>Components / footprints</td><td>{result.components.length}</td></tr>}
              {result.nets && result.nets.length > 0 && <tr><td>Nets</td><td>{result.nets.length} ({result.nets.slice(0, 6).join(', ')}{result.nets.length > 6 ? '…' : ''})</td></tr>}
              {result.svg && <tr><td>Artwork</td><td>SVG extracted &amp; sanitized</td></tr>}
              {result.layers && <tr><td>Layers</td><td>{result.layers.map((l) => l.name).join(', ')}</td></tr>}
              {result.objectCounts && (
                <tr><td>Parsed objects</td><td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  {Object.entries(result.objectCounts).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                </td></tr>
              )}
            </tbody>
          </table>
          {result.warnings.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {result.warnings.map((w, i) => (
                <div key={i} style={{ color: 'var(--warn)', fontSize: 12, marginBottom: 4 }}>⚠ {w}</div>
              ))}
            </div>
          )}
        </>
      ) : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
        <button className="btn" onClick={onBack}>Choose a different file</button>
        {result && <button className="btn primary" onClick={onNext}>Continue to mapping</button>}
      </div>
    </div>
  );
}

function MappingStep(props: {
  result: ImportParseResult;
  pins: ImportedPin[];
  setPins: (p: ImportedPin[]) => void;
  options: ImportOptions;
  setOptions: (o: ImportOptions) => void;
  csvMapping: Record<string, number>;
  setCsvMapping: (m: Record<string, number>) => void;
  layerVisibility: Record<string, boolean>;
  setLayerVisibility: (v: Record<string, boolean>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { result, pins, setPins, options, setOptions, csvMapping, setCsvMapping, layerVisibility, setLayerVisibility, onBack, onNext } = props;
  const isFullProject = Boolean(result.project);

  return (
    <div style={{ maxWidth: 900 }}>
      {isFullProject ? (
        <div style={{ color: 'var(--text-1)' }}>
          This is a complete CircuitDesk project, so there is nothing to map. Continue to the preview.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 14 }}>
            <div className="prop-row"><label>Name</label>
              <input style={{ width: 200 }} value={options.name} onChange={(e) => setOptions({ ...options, name: e.target.value })} />
            </div>
            <div className="prop-row"><label>Width (mm)</label>
              <input style={{ width: 80 }} type="number" step="0.5" value={Number(options.widthMm.toFixed(1))} onChange={(e) => setOptions({ ...options, widthMm: Math.max(2, Number(e.target.value)) })} />
            </div>
            <div className="prop-row"><label>Height (mm)</label>
              <input style={{ width: 80 }} type="number" step="0.5" value={Number(options.heightMm.toFixed(1))} onChange={(e) => setOptions({ ...options, heightMm: Math.max(2, Number(e.target.value)) })} />
            </div>
            <div className="prop-row"><label>Support level</label>
              <select value={options.supportLevel} onChange={(e) => setOptions({ ...options, supportLevel: e.target.value as SupportLevel })}>
                <option value="visual-only">Visual only</option>
                <option value="wiring">Wiring</option>
                <option value="validation">Validation</option>
              </select>
            </div>
          </div>

          {result.csv && (
            <>
              <div className="dash-section-title">CSV column mapping</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                {['pin', 'label', 'x', 'y', 'type', 'voltage', 'maxCurrent', 'capabilities', 'notes'].map((field) => (
                  <div className="prop-row" key={field} style={{ marginBottom: 0 }}>
                    <label>{field}</label>
                    <select
                      style={{ width: 110 }}
                      value={csvMapping[field] ?? -2}
                      onChange={(e) => {
                        const next = { ...csvMapping, [field]: Number(e.target.value) };
                        setCsvMapping(next);
                        setPins(autoMapCsvPins(result.csv!.headers, result.csv!.rows, next));
                      }}
                    >
                      <option value={-2}>auto</option>
                      <option value={-1}>none</option>
                      {result.csv!.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </>
          )}

          {result.layers && (
            <>
              <div className="dash-section-title">Layer visibility</div>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
                {result.layers.map((l) => (
                  <label key={l.name} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={layerVisibility[l.name] ?? l.visible}
                      onChange={(e) => setLayerVisibility({ ...layerVisibility, [l.name]: e.target.checked })}
                    />
                    {l.name} <span style={{ color: 'var(--text-2)' }}>({l.kind})</span>
                  </label>
                ))}
              </div>
            </>
          )}

          <div className="dash-section-title">Pins ({pins.length})</div>
          <PinPlacementEditor
            svg={result.svg}
            widthMm={options.widthMm}
            heightMm={options.heightMm}
            pins={pins}
            onChange={setPins}
          />
        </>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
        <button className="btn" onClick={onBack}>Back</button>
        <button className="btn primary" onClick={onNext}>Continue to preview</button>
      </div>
    </div>
  );
}

function PreviewStep({ result, pins, options, layerVisibility, onBack, onNext }: {
  result: ImportParseResult;
  pins: ImportedPin[];
  options: ImportOptions;
  layerVisibility: Record<string, boolean>;
  onBack: () => void;
  onNext: () => void;
}) {
  const scale = Math.min(520 / options.widthMm, 340 / options.heightMm);
  const artHref = result.svg ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(result.svg)))}` : undefined;

  return (
    <div style={{ maxWidth: 860 }}>
      {result.project ? (
        <table className="kv-table" style={{ maxWidth: 460 }}>
          <tbody>
            <tr><td>Project</td><td><strong>{result.project.name}</strong></td></tr>
            <tr><td>Boards</td><td>{result.project.boardInstances.length}</td></tr>
            <tr><td>Components</td><td>{result.project.componentInstances.length}</td></tr>
            <tr><td>Wires</td><td>{result.project.connections.length}</td></tr>
            <tr><td>Code files</td><td>{result.project.codeFiles.map((f) => f.name).join(', ')}</td></tr>
            <tr><td>Tests</td><td>{result.project.tests.length}</td></tr>
          </tbody>
        </table>
      ) : (
        <>
          <svg
            width={options.widthMm * scale}
            height={options.heightMm * scale}
            style={{ background: '#10151b', border: '1px solid var(--border)', borderRadius: 6 }}
          >
            {artHref ? (
              <image href={artHref} width={options.widthMm * scale} height={options.heightMm * scale} preserveAspectRatio="xMidYMid meet" />
            ) : result.layers ? (
              <GerberPreview layers={result.layers} visibility={layerVisibility} scale={scale} />
            ) : (
              <rect width={options.widthMm * scale} height={options.heightMm * scale} fill="#1d2530" rx="4" />
            )}
            {pins.map((p) => (
              <circle key={p.id} cx={p.xMm * scale} cy={p.yMm * scale} r="3.5" fill="rgba(201,162,39,0.95)" stroke="#0d1117" />
            ))}
          </svg>
          <div style={{ marginTop: 10, color: 'var(--text-1)', fontSize: 12.5 }}>
            {options.name} · {options.widthMm.toFixed(1)} × {options.heightMm.toFixed(1)} mm · {pins.length} pin(s) ·{' '}
            <SupportBadge level={options.target === 'visual-reference' ? 'visual-only' : options.supportLevel} />
          </div>
        </>
      )}
      {result.warnings.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {result.warnings.map((w, i) => (
            <div key={i} style={{ color: 'var(--warn)', fontSize: 12, marginBottom: 3 }}>⚠ {w}</div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
        <button className="btn" onClick={onBack}>Back</button>
        <button className="btn primary" onClick={onNext}>Continue to import</button>
      </div>
    </div>
  );
}

function GerberPreview({ layers, visibility, scale }: { layers: NonNullable<ImportParseResult['layers']>; visibility: Record<string, boolean>; scale: number }) {
  const colors: Record<string, string> = { copper: '#c9832a', silk: '#e8ebee', mask: '#1a5c38', outline: '#e8c35a', drill: '#10151b', other: '#7a8894' };
  return (
    <g>
      {layers.filter((l) => visibility[l.name] ?? l.visible).map((layer) => (
        <g key={layer.name}>
          {layer.paths.map((path, i) => (
            <polyline
              key={i}
              points={path.map((p) => `${p.x * scale},${p.y * scale}`).join(' ')}
              stroke={colors[layer.kind]}
              strokeWidth={Math.max(0.6, 0.25 * scale)}
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
          ))}
          {layer.flashes.map((f, i) => (
            <circle key={i} cx={f.x * scale} cy={f.y * scale} r={Math.max(0.8, (f.d / 2) * scale)} fill={colors[layer.kind]} opacity="0.9" />
          ))}
        </g>
      ))}
    </g>
  );
}

function ImportStep({ result, pins, options, setOptions, importing, onBack, onImport }: {
  result: ImportParseResult;
  pins: ImportedPin[];
  options: ImportOptions;
  setOptions: (o: ImportOptions) => void;
  importing: boolean;
  onBack: () => void;
  onImport: () => void;
}) {
  const [existingMetas, setExistingMetas] = useState<ProjectMeta[] | null>(null);
  const [existingId, setExistingId] = useState('');

  const targets = useMemo(() => {
    const list: { id: ImportOptions['target']; label: string; desc: string; disabled?: boolean }[] = [
      { id: 'new-project', label: 'Import as new project', desc: result.project ? 'Restores the full project.' : 'Creates a project containing the imported part.' },
      { id: 'existing-project', label: 'Import into existing project', desc: 'Adds the imported part (and its definition) to a project you pick.', disabled: Boolean(result.project) },
      { id: 'board-studio', label: 'Open in the Board Studio', desc: 'Bring it in as YOUR board: say what chip is on it, map its pins to processor pads, and compile and run firmware for it.', disabled: Boolean(result.project) },
      { id: 'custom-board', label: 'Import as custom board', desc: 'Saved to your board library as a wiring-only part, reusable across projects.', disabled: Boolean(result.project) },
      { id: 'custom-component', label: 'Import as custom component', desc: 'Saved to the component library.', disabled: Boolean(result.project) },
      { id: 'visual-reference', label: 'Import as visual reference', desc: 'Artwork only, badged “visual only”.', disabled: Boolean(result.project) },
    ];
    return list;
  }, [result.project]);

  const importIntoExisting = async () => {
    if (!existingId) return;
    try {
    const project = await loadProject(existingId);
    if (!project) {
      toast('Selected project could not be loaded.', 'error');
      return;
    }
    const custom = buildCustomDefinition(result, options, pins);
    project.customDefinitions.push(custom);
    const inst = { id: uid('inst'), definitionId: custom.definition.id, x: 120, y: 120, rotation: 0, properties: {}, simulationState: {} };
    if (custom.kind === 'board') project.boardInstances.push(inst);
    else project.componentInstances.push(inst);
    project.updatedAt = new Date().toISOString();
    await saveProject(project);
    toast(`Imported “${custom.definition.name}” into ${project.name}`, 'success');
    navigate(`#/editor/${project.id}`);
    } catch (err) {
      console.error('[CircuitDesk] import into existing project failed:', err);
      toast('Import failed. The target project was not changed; the browser console has the details.', 'error');
    }
  };

  return (
    <div style={{ maxWidth: 660 }}>
      <div className="dash-section-title">Choose import target</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {targets.map((t) => (
          <label
            key={t.id}
            style={{
              display: 'flex', gap: 10, padding: '10px 12px',
              background: 'var(--bg-2)', border: `1px solid ${options.target === t.id ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 7, cursor: t.disabled ? 'not-allowed' : 'pointer', opacity: t.disabled ? 0.45 : 1,
            }}
          >
            <input
              type="radio"
              checked={options.target === t.id}
              disabled={t.disabled}
              onChange={() => {
                setOptions({ ...options, target: t.id });
                if (t.id === 'existing-project' && existingMetas === null) {
                  void listProjectMetas().then(setExistingMetas);
                }
              }}
            />
            <div>
              <div style={{ fontWeight: 600 }}>{t.label}</div>
              <div style={{ color: 'var(--text-2)', fontSize: 11.5 }}>{t.desc}</div>
            </div>
          </label>
        ))}
      </div>

      {options.target === 'existing-project' && (
        <div style={{ marginTop: 12 }}>
          <select value={existingId} onChange={(e) => setExistingId(e.target.value)} style={{ width: 320 }}>
            <option value="">Select a project…</option>
            {(existingMetas ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
        <button className="btn" onClick={onBack}>Back</button>
        {options.target === 'existing-project' ? (
          <button className="btn primary" disabled={!existingId || importing} onClick={() => void importIntoExisting()}>
            <CheckIcon style={{ width: 14, height: 14 }} /> Import into project
          </button>
        ) : (
          <button className="btn primary" disabled={importing} onClick={onImport}>
            <CheckIcon style={{ width: 14, height: 14 }} /> {importing ? 'Importing…' : 'Import'}
          </button>
        )}
      </div>
    </div>
  );
}
