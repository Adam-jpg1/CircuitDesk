import { useEffect, useState } from 'react';
import { useCustomPartsStore } from './customPartsStore';
import { navigate, Modal, SupportBadge, toast, downloadFile } from '../ui/primitives';
import { BackIcon, LogoIcon, PlusIcon, ImportIcon } from '../ui/icons';
import { PinPlacementEditor } from '../import/PinPlacementEditor';
import { sanitizeSvg } from '../import/security';
import { pinsToDefinitions } from '../import/convert';
import type { ImportedPin } from '../import/types';
import { uid, type BoardDefinition, type CustomDefinition, type SupportLevel } from '../types';

export function CustomPartsPage() {
  const { parts, loaded, refresh, remove } = useCustomPartsStore();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CustomDefinition | null>(null);

  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  return (
    <div className="dashboard">
      <header className="dash-header">
        <button className="icon-btn" onClick={() => navigate('#/')}><BackIcon /></button>
        <span className="dash-brand"><LogoIcon /> CircuitDesk <span className="tagline">Custom board &amp; part library</span></span>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => navigate('#/import')}><ImportIcon style={{ width: 14, height: 14 }} /> Import a part</button>
        <button className="btn primary" onClick={() => setCreating(true)}><PlusIcon style={{ width: 14, height: 14 }} /> New custom board</button>
      </header>
      <div className="dash-body">
        {parts.length === 0 ? (
          <div className="empty-state" style={{ paddingTop: 60 }}>
            <p>No custom parts yet.</p>
            <p style={{ maxWidth: 440, fontSize: 12 }}>
              Create a board from your own SVG artwork with named, positioned pins, or import KiCad / Eagle /
              Fritzing / Gerber files from the import center. Custom parts appear in the editor library and can be
              reused in every project.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn primary" onClick={() => setCreating(true)}>Create custom board</button>
              <button className="btn" onClick={() => navigate('#/import')}>Open import center</button>
            </div>
          </div>
        ) : (
          <div className="project-grid">
            {parts.map((p) => (
              <div key={p.definition.id} className="project-card" onClick={() => setEditing(structuredClone(p))}>
                <div className="project-thumb">
                  {p.definition.artwork.kind === 'svg' && p.definition.artwork.svg ? (
                    <img
                      alt=""
                      style={{ maxWidth: '90%', maxHeight: '90%' }}
                      src={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(p.definition.artwork.svg)))}`}
                    />
                  ) : (
                    <span style={{ color: 'var(--text-2)', fontSize: 24 }}>▦</span>
                  )}
                </div>
                <div className="project-card-body">
                  <div className="project-card-title">{p.definition.name}</div>
                  <div className="project-card-meta">
                    <span>{p.kind}</span>
                    <span>{p.definition.pins.length} pins</span>
                    <span>{p.definition.widthMm.toFixed(0)}×{p.definition.heightMm.toFixed(0)} mm</span>
                  </div>
                  <div className="project-card-footer">
                    <SupportBadge level={p.definition.supportLevel} />
                    <div style={{ display: 'flex', gap: 5 }}>
                      <button
                        className="btn sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          downloadFile(
                            `${p.definition.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.board.json`,
                            JSON.stringify({ app: 'CircuitDesk', kind: 'board-definition', definition: p.definition }, null, 2),
                            'application/json',
                          );
                        }}
                      >
                        Export
                      </button>
                      <button
                        className="btn sm danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`Delete custom part “${p.definition.name}”?`)) void remove(p.definition.id);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {(creating || editing) && (
        <CustomBoardEditor
          existing={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
        />
      )}
    </div>
  );
}

function CustomBoardEditor({ existing, onClose }: { existing: CustomDefinition | null; onClose: () => void }) {
  const def = existing?.definition;
  const [name, setName] = useState(def?.name ?? 'My Custom Board');
  const [widthMm, setWidthMm] = useState(def?.widthMm ?? 50);
  const [heightMm, setHeightMm] = useState(def?.heightMm ?? 35);
  const [supportLevel, setSupportLevel] = useState<SupportLevel>(def?.supportLevel ?? 'wiring');
  const [svg, setSvg] = useState<string | undefined>(def?.artwork.kind === 'svg' ? def.artwork.svg : undefined);
  const [imageDataUrl, setImageDataUrl] = useState<string | undefined>(def?.artwork.kind === 'image' ? def.artwork.imageDataUrl : undefined);
  const [notes, setNotes] = useState(def?.description ?? '');
  const [pins, setPins] = useState<ImportedPin[]>(
    def?.pins.map((p) => ({
      id: p.id, label: p.label, xMm: p.x / 4, yMm: p.y / 4, type: p.type,
      voltage: p.voltage, maxCurrentMa: p.maxCurrentMa, notes: p.description,
    })) ?? [],
  );

  const pickArtwork = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.svg,.png,.jpg,.jpeg';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        if (f.name.toLowerCase().endsWith('.svg')) {
          setSvg(sanitizeSvg(await f.text()));
          setImageDataUrl(undefined);
        } else {
          if (f.size > 4 * 1024 * 1024) throw new Error('Image too large (max 4 MB).');
          const reader = new FileReader();
          reader.onload = () => {
            setImageDataUrl(String(reader.result));
            setSvg(undefined);
          };
          reader.readAsDataURL(f);
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not load artwork', 'error');
      }
    };
    input.click();
  };

  const save = async () => {
    if (!name.trim()) return;
    const definition: BoardDefinition = {
      id: def?.id ?? uid('customboard'),
      name: name.trim(),
      family: 'Custom',
      architecture: 'other',
      aliases: [],
      compiler: { provider: 'none', supported: false },
      simulation: { engine: 'none', supported: false, supportedApis: [], supportedPeripherals: [] },
      processor: 'user-defined',
      widthMm,
      heightMm,
      artwork: svg ? { kind: 'svg', svg } : imageDataUrl ? { kind: 'image', imageDataUrl } : { kind: 'builtin', builtinId: 'generic' },
      pins: pinsToDefinitions(pins),
      supportLevel,
      metadata: {},
      description: notes || undefined,
      isBoard: true,
    };
    try {
      await useCustomPartsStore.getState().add({
        kind: 'board',
        definition,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        source: existing?.source ?? 'creator',
      });
      toast(`Saved “${definition.name}”`, 'success');
      onClose();
    } catch (err) {
      console.error('[CircuitDesk] failed to save custom part:', err);
      toast('Could not save the part to local storage. See the browser console for details.', 'error');
    }
  };

  return (
    <Modal
      title={existing ? `Edit ${existing.definition.name}` : 'New custom board'}
      onClose={onClose}
      width={760}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void save()}>Save to library</button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="prop-row"><label>Name</label><input style={{ width: 190 }} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="prop-row"><label>Width (mm)</label><input style={{ width: 74 }} type="number" step="0.5" value={widthMm} onChange={(e) => setWidthMm(Math.max(2, Number(e.target.value)))} /></div>
        <div className="prop-row"><label>Height (mm)</label><input style={{ width: 74 }} type="number" step="0.5" value={heightMm} onChange={(e) => setHeightMm(Math.max(2, Number(e.target.value)))} /></div>
        <div className="prop-row">
          <label>Support level</label>
          <select value={supportLevel} onChange={(e) => setSupportLevel(e.target.value as SupportLevel)}>
            <option value="visual-only">Visual only</option>
            <option value="wiring">Wiring</option>
            <option value="validation">Validation</option>
          </select>
        </div>
        <button className="btn sm" onClick={pickArtwork}>{svg || imageDataUrl ? 'Replace artwork…' : 'Upload SVG / image…'}</button>
      </div>
      <PinPlacementEditor svg={svg} imageDataUrl={imageDataUrl} widthMm={widthMm} heightMm={heightMm} pins={pins} onChange={setPins} />
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginBottom: 4 }}>Notes / documentation</div>
        <textarea style={{ width: '100%', minHeight: 54 }} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div style={{ color: 'var(--text-2)', fontSize: 11, marginTop: 8 }}>
        Custom boards can be placed, wired and validated, but are not simulated.
      </div>
    </Modal>
  );
}
