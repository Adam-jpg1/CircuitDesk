import { useMemo } from 'react';
import { useEditorStore } from '../app/editorStore';
import { useSimulationStore } from '../simulation/simulationStore';
import { resolveDefinition } from '../project/partsRegistry';
import { analyzeCodePins } from '../compiler/codeAnalysis';
import { arduinoPinNumber } from '../boards/pinMaps';
import { describeSupport } from '../project/support';
import { SupportBadge } from '../ui/primitives';
import { revealCodeLocation } from './CodePanel';
import type { ComponentInstance, Connection, PartDefinition } from '../types';

export function Inspector() {
  const project = useEditorStore((s) => s.project);
  const selection = useEditorStore((s) => s.selection);

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
              Hover a pin for its electrical details. Use the Wire tool (W) or click any pin to start a connection.
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
            {def.family} · {def.processor}
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
              return (
                <tr key={pin.id} className={conns.length > 0 ? 'connected' : ''}>
                  <td>{pin.label}</td>
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
            {def.supportLevel === 'validation' ? 'Validation only — this part is checked by the validator but not simulated.' :
             def.supportLevel === 'wiring' ? 'Not simulated — wiring support only.' : 'Visual only.'}
          </div>
        </div>
      );
    }
    return null;
  }
  const disabled = simStatus === 'stopped' || simStatus === 'error';

  return (
    <div className="inspector-section">
      <h4>Simulation controls</h4>
      {disabled && <div style={{ color: 'var(--text-2)', fontSize: 11.5, marginBottom: 6 }}>Start the simulation to interact.</div>}
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
      {adapter === 'sim.potentiometer' && (
        <div>
          <input
            type="range" min="0" max="1" step="0.01" disabled={disabled}
            value={potPositions[inst.id] ?? 0.5}
            onChange={(e) => sim.getState().setPot(inst.id, Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Wiper: {Math.round((potPositions[inst.id] ?? 0.5) * 100)}%</div>
        </div>
      )}
      {adapter === 'sim.ultrasonic' && (
        <div>
          <input
            type="range" min="2" max="400" step="1" disabled={disabled}
            value={sensorValues[inst.id] ?? 100}
            onChange={(e) => sim.getState().setSensor(inst.id, Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Distance: {sensorValues[inst.id] ?? 100} cm</div>
        </div>
      )}
      {adapter === 'sim.tmp36' && (
        <div>
          <input
            type="range" min="-40" max="125" step="1" disabled={disabled}
            value={sensorValues[inst.id] ?? 25}
            onChange={(e) => sim.getState().setSensor(inst.id, Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Temperature: {sensorValues[inst.id] ?? 25} °C</div>
        </div>
      )}
      {adapter === 'sim.ldr' && (
        <div>
          <input
            type="range" min="0" max="1" step="0.01" disabled={disabled}
            value={sensorValues[inst.id] ?? 0.5}
            onChange={(e) => sim.getState().setSensor(inst.id, Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Light level: {Math.round((sensorValues[inst.id] ?? 0.5) * 100)}%</div>
        </div>
      )}
      {adapter === 'sim.servo' && (
        <div style={{ fontSize: 11.5, color: 'var(--text-1)' }}>
          Horn angle: <b>{(visuals?.servoAngle ?? 90).toFixed(0)}°</b> — derived from the measured pulse width on the signal pin.
        </div>
      )}
      {adapter === 'sim.buzzer' && (
        <div style={{ fontSize: 11.5, color: 'var(--text-1)' }}>
          State: <b>{visuals?.buzzerOn ? 'sounding' : 'silent'}</b>
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

function ConnectionInspector({ conn }: { conn: Connection }) {
  const project = useEditorStore((s) => s.project)!;
  const s = useEditorStore.getState();
  const endName = (instId: string, pinId: string) => {
    const inst = [...project.boardInstances, ...project.componentInstances].find((i) => i.id === instId);
    const def = inst ? resolveDefinition(inst.definitionId, project) : undefined;
    const pin = def?.pins.find((p) => p.id === pinId);
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
