import { useEffect, useMemo, useState } from 'react';
import { useEditorStore } from '../app/editorStore';
import { useSimulationStore } from '../simulation/simulationStore';
import { resolveDefinition, resolvePin } from '../project/partsRegistry';
import { analyzeCodePins } from '../compiler/codeAnalysis';
import { arduinoPinNumber } from '../boards/pinMaps';
import { describeSupport } from '../project/support';
import { SupportBadge } from '../ui/primitives';
import {
  clampQuantity,
  controlKey,
  inputControlsFor,
  quantityValue,
  type InputQuantity,
} from '../simulation/inputControls';
import { revealCodeLocation } from './CodePanel';
import { useIsPhone } from './phoneLayout';
import type { ComponentInstance, Connection, PartDefinition } from '../types';

export function Inspector() {
  const project = useEditorStore((s) => s.project);
  const selection = useEditorStore((s) => s.selection);
  const phone = useIsPhone();

  if (!project) return null;
  const inst = [...project.boardInstances, ...project.componentInstances].find(
    (i) => i.id === selection.componentIds[0],
  );
  const conn = project.connections.find((c) => c.id === selection.connectionIds[0]);

  return (
    <>
      <div className="panel-header"><span>Inspector</span></div>
      <div className="panel-scroll inspector">
        {inst ? (
          <InstanceInspector inst={inst} />
        ) : conn ? (
          <ConnectionInspector conn={conn} />
        ) : (
          <div className="empty-state">
            <p>Select a component, board or wire to inspect it.</p>
            <p style={{ fontSize: 11.5 }}>
              {phone
                ? 'Tap a part on the circuit to inspect it. Choose Wire, then tap two pins to connect them.'
                : 'Hover a pin for its electrical details. Use the Wire tool (W) or click any pin to start a connection.'}
            </p>
          </div>
        )}
      </div>
    </>
  );
}

function InstanceInspector({ inst }: { inst: ComponentInstance }) {
  const project = useEditorStore((s) => s.project)!;
  const validationIssues = useEditorStore((s) => s.validationIssues);
  const def = resolveDefinition(inst.definitionId, project);
  const simStatus = useSimulationStore((s) => s.status);

  const connectionsByPin = useMemo(() => {
    const map = new Map<string, Connection[]>();
    for (const c of project.connections) {
      if (c.sourceComponentId === inst.id) map.set(c.sourcePinId, [...(map.get(c.sourcePinId) ?? []), c]);
      if (c.targetComponentId === inst.id) map.set(c.targetPinId, [...(map.get(c.targetPinId) ?? []), c]);
    }
    return map;
  }, [project.connections, inst.id]);

  const codeUsage = useMemo(() => analyzeCodePins(project.codeFiles), [project.codeFiles]);

  if (!def) return <div className="empty-state">Unknown part definition: {inst.definitionId}</div>;
  const s = useEditorStore.getState();
  const myIssues = validationIssues.filter((i) => i.affectedComponentIds.includes(inst.id));

  return (
    <>
      <div className="inspector-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 13.5 }}>{def.name}</strong>
          <SupportBadge level={def.supportLevel} title={describeSupport(def)} />
        </div>
        {def.isBoard && (
          <div style={{ color: 'var(--text-2)', marginTop: 4, fontSize: 11.5 }}>
            {/* Who makes it comes first: the name above is the manufacturer's
                own product name, and saying whose it is keeps CircuitDesk from
                appearing to be the source of someone else's hardware. */}
            {'manufacturer' in def && def.manufacturer ? `${def.manufacturer} · ` : ''}
            {def.family} · {def.processor}
          </div>
        )}
        {def.isBoard && typeof def.metadata?.identityNote === 'string' && (
          <div style={{ color: 'var(--text-2)', marginTop: 4, fontSize: 11, fontStyle: 'italic' }}>
            {def.metadata.identityNote as string}
          </div>
        )}
        {def.description && <p style={{ color: 'var(--text-1)', fontSize: 11.5, lineHeight: 1.5, marginBottom: 0 }}>{def.description}</p>}
      </div>

      <div className="inspector-section">
        <h4>Instance</h4>
        <div className="prop-row">
          <label>Label</label>
          <input
            defaultValue={inst.label ?? ''}
            key={inst.id}
            placeholder="optional label"
            onBlur={(e) => e.target.value !== (inst.label ?? '') && s.setInstanceLabel(inst.id, e.target.value)}
          />
        </div>
        <div className="prop-row">
          <label>Position</label>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
            {Math.round(inst.x)}, {Math.round(inst.y)} · {inst.rotation}°
          </span>
        </div>
      </div>

      {!def.isBoard && def.properties.length > 0 && (
        <div className="inspector-section">
          <h4>Properties</h4>
          {def.properties.map((prop) => {
            const value = inst.properties[prop.key] ?? prop.default;
            return (
              <div className="prop-row" key={prop.key}>
                <label>{prop.label}{prop.unit ? ` (${prop.unit})` : ''}</label>
                {prop.kind === 'select' ? (
                  <select value={String(value)} onChange={(e) => s.setInstanceProperty(inst.id, prop.key, e.target.value)}>
                    {prop.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : prop.kind === 'number' ? (
                  <input
                    type="number"
                    value={Number(value)}
                    min={prop.min}
                    max={prop.max}
                    onChange={(e) => s.setInstanceProperty(inst.id, prop.key, Number(e.target.value))}
                  />
                ) : prop.kind === 'boolean' ? (
                  <input type="checkbox" checked={Boolean(value)} onChange={(e) => s.setInstanceProperty(inst.id, prop.key, e.target.checked)} />
                ) : (
                  <input value={String(value)} onChange={(e) => s.setInstanceProperty(inst.id, prop.key, e.target.value)} />
                )}
              </div>
            );
          })}
        </div>
      )}

      <SimControls inst={inst} def={def} simStatus={simStatus} />

      {myIssues.length > 0 && (
        <div className="inspector-section">
          <h4>Validation ({myIssues.length})</h4>
          {myIssues.map((i) => (
            <div key={i.id} style={{ fontSize: 11.5, marginBottom: 6, color: i.severity === 'error' ? '#ff8a80' : i.severity === 'warning' ? '#e8c35a' : 'var(--text-1)' }}>
              {i.title}
            </div>
          ))}
        </div>
      )}

      <div className="inspector-section">
        <h4>Pins ({def.pins.length})</h4>
        <table className="pin-table">
          <thead>
            <tr><th>Pin</th><th>Type</th><th>Wires</th><th>Code</th></tr>
          </thead>
          <tbody>
            {def.pins.slice(0, 64).map((pin) => {
              const conns = connectionsByPin.get(pin.id) ?? [];
              const arduinoPin = def.isBoard ? arduinoPinNumber(def, pin.id) : undefined;
              const refs = arduinoPin !== undefined ? codeUsage.refs.filter((r) => r.pin === arduinoPin) : [];
              // Narrowed through `isBoard`, which is the discriminant on the
              // union: only a board has a pad map, and a component asked for
              // one would be a question with no meaning rather than a missing
              // value.
              const pad = def.isBoard ? def.padMap?.[pin.id] : undefined;
              return (
                <tr key={pin.id} className={conns.length > 0 ? 'connected' : ''}>
                  {/* The maker's name, and the processor pad behind it. Both
                      are true, and the pad is what firmware is written
                      against — a person reading this table is usually holding
                      a sketch that says GP15. */}
                  <td>
                    {pin.label}
                    {pad && pad !== pin.label && <span style={{ color: 'var(--text-2)' }}> · {pad}</span>}
                  </td>
                  <td style={{ color: 'var(--text-2)' }}>{pin.type}{pin.voltage != null ? ` ${pin.voltage}V` : ''}</td>
                  <td>{conns.length || '—'}</td>
                  <td>
                    {refs.length > 0 ? (
                      <button
                        className="btn sm"
                        style={{ padding: '0 6px', fontSize: 10.5 }}
                        title={`Highlight ${refs.length} code reference(s)`}
                        onClick={() => revealCodeLocation(refs[0].fileId, refs[0].line, refs[0].column, refs[0].length)}
                      >
                        {refs.length}×
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {def.pins.length > 64 && (
          <div style={{ color: 'var(--text-2)', fontSize: 11, marginTop: 4 }}>
            + {def.pins.length - 64} more pins (breadboard holes are grouped electrically by column).
          </div>
        )}
      </div>
    </>
  );
}

function SimControls({ inst, def, simStatus }: { inst: ComponentInstance; def: PartDefinition; simStatus: string }) {
  const circuitLive = useSimulationStore((x) => x.circuitLive);
  const sim = useSimulationStore;
  const potPositions = useSimulationStore((s) => s.potPositions);
  const sensorValues = useSimulationStore((s) => s.sensorValues);
  const toggleStates = useSimulationStore((s) => s.toggleStates);
  const visuals = useSimulationStore((s) => s.visuals[inst.id]);

  if (def.isBoard) return null;
  const adapter = def.simulationAdapterId;
  if (!adapter || adapter === 'sim.led' || adapter === 'sim.rgb-led' || adapter === 'sim.resistor' || adapter === 'sim.supply') {
    if (def.supportLevel !== 'simulated') {
      return (
        <div className="inspector-section">
          <h4>Simulation</h4>
          <div style={{ color: 'var(--text-2)', fontSize: 11.5 }}>
            {def.supportLevel === 'validation' ? 'Validation only: the validator checks this part, but it is not simulated.' :
             def.supportLevel === 'wiring' ? 'Not simulated. Wiring support only.' : 'Visual only.'}
          </div>
        </div>
      );
    }
    return null;
  }
  const disabled = (simStatus === 'stopped' || simStatus === 'error') && !circuitLive;
  const inputs = inputControlsFor(def.id);

  return (
    <div className="inspector-section">
      <h4>Simulation controls</h4>
      {disabled && (
        <div style={{ color: 'var(--text-2)', fontSize: 11.5, marginBottom: 6 }}>
          {inputs ? 'Values set now apply when the simulation starts.' : 'Start the simulation to interact.'}
        </div>
      )}
      {inputs?.kind === 'quantities' && (
        <div style={{ display: 'grid', gap: 8, marginBottom: 6 }}>
          {inputs.quantities.map((q) => {
            const key = controlKey(inst.id, q);
            const values = q.store === 'pot' ? potPositions : sensorValues;
            const value = quantityValue((k) => values[k], inst, q);
            const write = (v: number) =>
              q.store === 'pot' ? sim.getState().setPot(key, v) : sim.getState().setSensor(key, v);
            return <QuantityControl key={key} id={key} q={q} value={value} onChange={write} />;
          })}
          {inputs.note && <div style={{ fontSize: 11, color: 'var(--text-2)' }}>{inputs.note}</div>}
        </div>
      )}
      {inputs?.kind === 'trigger' && (
        <div style={{ display: 'grid', gap: 6, marginBottom: 6 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={(sensorValues[inst.id] ?? 0) > 0.5}
              onChange={(e) => sim.getState().setSensor(inst.id, e.target.checked ? 1 : 0)}
            />
            {inputs.label}
            {visuals?.ledOn ? <span style={{ color: 'var(--accent)' }}>● output active</span> : null}
          </label>
          {inputs.latching && (
            <button
              className="btn sm"
              disabled={disabled}
              onClick={() => {
                // One event: asserted for a moment, then released. The part's
                // own hold time keeps its output up afterwards, as on the bench.
                sim.getState().setSensor(inst.id, 1);
                setTimeout(() => sim.getState().setSensor(inst.id, 0), 150);
              }}
            >
              Trigger once
            </button>
          )}
          {inputs.note && <div style={{ fontSize: 11, color: 'var(--text-2)' }}>{inputs.note}</div>}
        </div>
      )}
      {adapter === 'sim.push-button' && (
        <button
          className="btn"
          disabled={disabled}
          onPointerDown={() => sim.getState().pressButton(inst.id, true)}
          onPointerUp={() => sim.getState().pressButton(inst.id, false)}
          onPointerLeave={() => sim.getState().pressButton(inst.id, false)}
        >
          Hold to press {visuals?.pressed ? '● pressed' : ''}
        </button>
      )}
      {adapter === 'sim.toggle-switch' && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            disabled={disabled}
            checked={toggleStates[inst.id] === true}
            onChange={(e) => sim.getState().setToggle(inst.id, e.target.checked)}
          />
          Switch on (COM→NO)
        </label>
      )}
      {adapter === 'sim.keypad' && (
        <div>
          <button className="btn" onClick={() => useEditorStore.getState().setKeyPanel(inst.id)}>
            Open key panel
          </button>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>
            A bigger view of the same keys. Pressing one closes a crossing in the matrix, and the firmware has to
            scan for it, as on a real keypad.
          </div>
        </div>
      )}
      {adapter === 'sim.joystick' && (
        // Two wipers, because that is what the module is: the sliders set the
        // same positions the axes impose on VRx and VRy, so what the stick
        // shows and what the ADC reads are one number each.
        <button
          className="btn sm"
          style={{ marginBottom: 6 }}
          onClick={() => {
            sim.getState().setPot(`${inst.id}#x`, 0.5);
            sim.getState().setPot(`${inst.id}#y`, 0.5);
          }}
        >
          Centre
        </button>
      )}
      {adapter === 'sim.servo' && (
        <div style={{ fontSize: 11.5, color: 'var(--text-1)' }}>
          Horn angle: <b>{(visuals?.servoAngle ?? 90).toFixed(0)}°</b>, from the measured pulse width on the signal pin.
        </div>
      )}
      {adapter === 'sim.buzzer' && (
        <div style={{ fontSize: 11.5, color: 'var(--text-1)' }}>
          State: <b>{visuals?.buzzerOn ? 'sounding' : 'silent'}</b>
        </div>
      )}
      {visuals?.fault && (
        <div style={{ fontSize: 11.5, color: '#f0b72f', marginBottom: 4 }} role="alert">
          ⚠ {visuals.fault}
        </div>
      )}
      {(adapter === 'sim.led' || adapter === 'sim.supply') && visuals?.currentMa !== undefined && (
        <div style={{ fontSize: 11.5, color: 'var(--text-1)' }}>
          Current: <b>{visuals.currentMa < 0.05 ? '0' : visuals.currentMa.toFixed(visuals.currentMa < 10 ? 1 : 0)} mA</b>
          {adapter === 'sim.supply' && visuals.readout?.[0] ? <> at <b>{visuals.readout[0]}</b></> : null}
        </div>
      )}
      {adapter === 'sim.speaker' && (
        <div style={{ fontSize: 11.5, color: 'var(--text-1)' }}>
          Playing: <b>{visuals?.buzzerOn ? `${Math.round(visuals.value ?? 0)} Hz` : 'silent'}</b>, measured from the pin
          driving it.
        </div>
      )}
      {adapter === 'sim.capacitor' && visuals?.readout?.length ? (
        <div style={{ fontSize: 11.5, color: 'var(--text-1)' }}>
          Charged to: <b>{visuals.readout[0]}</b>
        </div>
      ) : null}
      {adapter === 'sim.transistor' && visuals?.readout?.length ? (
        <div style={{ fontSize: 11.5, color: 'var(--text-1)' }}>
          State: <b>{visuals.readout[0]}</b>
        </div>
      ) : null}
      {(adapter === 'sim.hc595' || adapter === 'sim.sd-card' || adapter === 'sim.spi-flash') && (
        <div style={{ fontSize: 11.5, color: 'var(--text-1)' }}>
          {visuals?.readout?.length ? (
            <>
              {visuals.readout.map((line) => (
                <div key={line} style={{ fontFamily: 'var(--font-mono)' }}>{line}</div>
              ))}
              <div style={{ color: 'var(--text-2)', marginTop: 4 }}>
                Driven by real SPI traffic from the running firmware.
              </div>
            </>
          ) : (
            <span style={{ color: 'var(--text-2)' }}>
              Not on the SPI bus. Check SCK, MOSI{adapter === 'sim.hc595' ? '' : ', MISO, CS'}, VCC and GND, then start
              the simulation.
            </span>
          )}
        </div>
      )}
      {(adapter === 'sim.bmp280' || adapter === 'sim.mpu6050') && (
        <div style={{ fontSize: 11.5, color: 'var(--text-1)' }}>
          {visuals?.readout?.length ? (
            <>
              {visuals.readout.map((line) => (
                <div key={line}>{line}</div>
              ))}
              <div style={{ color: 'var(--text-2)', marginTop: 4 }}>
                Simulated environment served to firmware over I2C.
              </div>
            </>
          ) : (
            <span style={{ color: 'var(--text-2)' }}>
              Not on the bus. Check SDA/SCL, VCC and GND, then start the simulation.
            </span>
          )}
        </div>
      )}
      {adapter === 'sim.seven-segment' && (
        <div style={{ fontSize: 11.5, color: 'var(--text-1)' }}>
          Lit segments: <b>{Object.entries(visuals?.segments ?? {}).filter(([, v]) => v).map(([k]) => k.toUpperCase()).join(' ') || 'none'}</b>
        </div>
      )}
    </div>
  );
}

/**
 * One adjustable quantity: a slider for dragging and a number box for typing an
 * exact value. Both write the same stored value; the box accepts display units
 * (a light level of 40 means 40 %) and clamps to the part's real range when it
 * is committed with Enter or by leaving the field.
 */
function QuantityControl({
  id,
  q,
  value,
  onChange,
}: {
  id: string;
  q: InputQuantity;
  value: number;
  onChange: (stored: number) => void;
}) {
  const scale = q.scale ?? 1;
  const shown = (value * scale).toFixed(q.precision);
  const [draft, setDraft] = useState(shown);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(shown);
  }, [shown, editing]);

  const commit = () => {
    setEditing(false);
    const typed = Number(draft.trim().replace(',', '.'));
    if (draft.trim() === '' || !Number.isFinite(typed)) {
      setDraft(shown);
      return;
    }
    const stored = clampQuantity(q, typed / scale);
    onChange(stored);
    setDraft((stored * scale).toFixed(q.precision));
  };

  return (
    <div data-input-control={id}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
        <label htmlFor={`qc-${id}`} style={{ flex: 1, color: 'var(--text-1)' }}>
          {q.label}
        </label>
        <input
          id={`qc-${id}`}
          type="text"
          inputMode="decimal"
          aria-label={`${q.label} (${q.unit})`}
          value={draft}
          onFocus={() => setEditing(true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setDraft(shown);
              setEditing(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
          style={{ width: 72, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}
        />
        <span style={{ color: 'var(--text-2)', minWidth: 30 }}>{q.unit}</span>
      </div>
      <input
        type="range"
        aria-label={`${q.label} slider`}
        min={q.min}
        max={q.max}
        step={q.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
    </div>
  );
}

function ConnectionInspector({ conn }: { conn: Connection }) {
  const project = useEditorStore((s) => s.project)!;
  const s = useEditorStore.getState();
  const endName = (instId: string, pinId: string) => {
    const inst = [...project.boardInstances, ...project.componentInstances].find((i) => i.id === instId);
    const def = inst ? resolveDefinition(inst.definitionId, project) : undefined;
    const pin = resolvePin(def, pinId);
    return `${inst?.label || def?.name || '?'} · ${pin?.label ?? pinId}`;
  };
  return (
    <>
      <div className="inspector-section">
        <strong>Wire</strong>
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-1)' }}>
          {endName(conn.sourceComponentId, conn.sourcePinId)}
          <div style={{ color: 'var(--text-2)', margin: '2px 0' }}>↕</div>
          {endName(conn.targetComponentId, conn.targetPinId)}
        </div>
      </div>
      <div className="inspector-section">
        <h4>Appearance</h4>
        <div className="prop-row">
          <label>Color</label>
          <input type="color" value={conn.color} onChange={(e) => s.updateConnection(conn.id, { color: e.target.value })} />
        </div>
        <div className="prop-row">
          <label>Routing</label>
          <select value={conn.routing} onChange={(e) => s.updateConnection(conn.id, { routing: e.target.value as Connection['routing'] })}>
            <option value="smooth">Smooth</option>
            <option value="orthogonal">Orthogonal</option>
            <option value="straight">Straight</option>
          </select>
        </div>
        <div className="prop-row">
          <label>Label / net name</label>
          <input
            defaultValue={conn.label ?? ''}
            key={conn.id}
            onBlur={(e) => e.target.value !== (conn.label ?? '') && s.updateConnection(conn.id, { label: e.target.value })}
          />
        </div>
        <button className="btn sm danger" onClick={() => s.deleteSelection()}>Delete wire</button>
      </div>
    </>
  );
}
