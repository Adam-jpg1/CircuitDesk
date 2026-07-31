import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../app/editorStore';
import { useSimulationStore } from '../simulation/simulationStore';
import { resolveDefinition } from '../project/partsRegistry';
import { buildCircuitGraph } from '../circuit/nets';
import { arduinoPinNumber } from '../boards/pinMaps';
import { pinAbsolute, partBounds, partSize, wirePath, snap, type Pt } from './geometry';
import { ComponentArtwork } from '../components-library/artwork/componentArtwork';
import { UnoArtwork } from '../boards/artwork/UnoArtwork';
import { GenericModuleArtwork } from '../boards/artwork/GenericModuleArtwork';
import { MegaArtwork } from '../boards/artwork/MegaArtwork';
import type { CircuitProject, ComponentInstance, PartDefinition, PinDefinition } from '../types';

const WIRE_COLORS = ['#e03131', '#212529', '#2f9e44', '#1971c2', '#e8590c', '#7048e8', '#f08c00', '#c2255c'];

interface DragState {
  kind: 'move' | 'pan' | 'box';
  startClient: Pt;
  lastWorld: Pt;
  startView?: { x: number; y: number; zoom: number };
  boxStart?: Pt;
  moved: boolean;
}

export function CanvasStage() {
  const project = useEditorStore((s) => s.project);
  const tool = useEditorStore((s) => s.tool);
  const view = useEditorStore((s) => s.view);
  const selection = useEditorStore((s) => s.selection);
  const wireDraft = useEditorStore((s) => s.wireDraft);
  const highlightedIssueId = useEditorStore((s) => s.highlightedIssueId);
  const validationIssues = useEditorStore((s) => s.validationIssues);
  const store = useEditorStore;

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const dragRef = useRef<DragState | null>(null);
  const [boxRect, setBoxRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize((prev) => (Math.abs(prev.w - r.width) > 1 || Math.abs(prev.h - r.height) > 1 ? { w: r.width, h: r.height } : prev));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpaceHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const toWorld = useCallback(
    (clientX: number, clientY: number): Pt => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: view.x + (clientX - rect.left) / view.zoom,
        y: view.y + (clientY - rect.top) / view.zoom,
      };
    },
    [view],
  );

  const instances = useMemo(
    () => (project ? [...project.boardInstances, ...project.componentInstances] : []),
    [project],
  );

  const definitions = useMemo(() => {
    const map = new Map<string, PartDefinition>();
    for (const inst of instances) {
      const def = resolveDefinition(inst.definitionId, project);
      if (def) map.set(inst.id, def);
    }
    return map;
  }, [instances, project]);

  // fit view on demand
  const fitToView = useCallback(() => {
    if (instances.length === 0) {
      store.getState().setView({ x: -60, y: -40, zoom: 1 });
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const inst of instances) {
      const def = definitions.get(inst.id);
      if (!def) continue;
      const b = partBounds(inst, def);
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    const pad = 60;
    const zoom = Math.min(2.5, Math.max(0.15, Math.min(size.w / (maxX - minX + pad * 2), size.h / (maxY - minY + pad * 2))));
    store.getState().setView({
      x: minX - (size.w / zoom - (maxX - minX)) / 2,
      y: minY - (size.h / zoom - (maxY - minY)) / 2,
      zoom,
    });
  }, [instances, definitions, size, store]);

  useEffect(() => {
    (window as unknown as { __cdFit?: () => void }).__cdFit = fitToView;
  }, [fitToView]);

  // one-time fit after project load
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (project && fittedFor.current !== project.id) {
      fittedFor.current = project.id;
      fitToView();
    }
  }, [project, fitToView]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const worldBefore = toWorld(e.clientX, e.clientY);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const zoom = Math.min(4, Math.max(0.12, view.zoom * factor));
      store.getState().setView({
        x: worldBefore.x - (e.clientX - rect.left) / zoom,
        y: worldBefore.y - (e.clientY - rect.top) / zoom,
        zoom,
      });
    },
    [toWorld, view.zoom, store],
  );

  const finishWire = useCallback(
    (toComponentId: string, toPinId: string) => {
      const draft = store.getState().wireDraft;
      if (!draft) return;
      if (draft.fromComponentId === toComponentId && draft.fromPinId === toPinId) {
        store.getState().setWireDraft(null);
        return;
      }
      const colorIdx = (store.getState().project?.connections.length ?? 0) % WIRE_COLORS.length;
      store.getState().addConnection({
        sourceComponentId: draft.fromComponentId,
        sourcePinId: draft.fromPinId,
        targetComponentId: toComponentId,
        targetPinId: toPinId,
        color: WIRE_COLORS[colorIdx],
        points: draft.points,
        routing: 'smooth',
      });
      store.getState().setWireDraft(null);
    },
    [store],
  );

  const onPinClick = useCallback(
    (componentId: string, pin: PinDefinition, e: React.MouseEvent) => {
      e.stopPropagation();
      const s = store.getState();
      if (s.wireDraft) {
        finishWire(componentId, pin.id);
      } else {
        s.setWireDraft({ fromComponentId: componentId, fromPinId: pin.id, points: [], cursor: null });
      }
    },
    [store, finishWire],
  );

  const onBackgroundPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const world = toWorld(e.clientX, e.clientY);
      const s = store.getState();
      if (s.wireDraft) {
        // add a waypoint
        s.setWireDraft({ ...s.wireDraft, points: [...s.wireDraft.points, snap(world.x), snap(world.y)] });
        return;
      }
      const panMode = tool === 'pan' || spaceHeld || e.button === 1;
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      if (panMode) {
        dragRef.current = { kind: 'pan', startClient: { x: e.clientX, y: e.clientY }, lastWorld: world, startView: { ...view }, moved: false };
      } else if (tool === 'select') {
        dragRef.current = { kind: 'box', startClient: { x: e.clientX, y: e.clientY }, lastWorld: world, boxStart: world, moved: false };
        if (!e.shiftKey) s.setSelection({ componentIds: [], connectionIds: [] });
      }
    },
    [toWorld, tool, spaceHeld, view, store],
  );

  const onPartPointerDown = useCallback(
    (inst: ComponentInstance, e: React.PointerEvent) => {
      e.stopPropagation();
      const s = store.getState();
      const simRunning = useSimulationStore.getState().status === 'running';
      const def = definitions.get(inst.id);

      // interactive parts during simulation
      if (simRunning && def && !def.isBoard) {
        if (def.simulationAdapterId === 'sim.push-button') {
          useSimulationStore.getState().pressButton(inst.id, true);
          const release = () => {
            useSimulationStore.getState().pressButton(inst.id, false);
            window.removeEventListener('pointerup', release);
          };
          window.addEventListener('pointerup', release);
          return;
        }
        if (def.simulationAdapterId === 'sim.toggle-switch') {
          const cur = useSimulationStore.getState().toggleStates[inst.id] === true;
          useSimulationStore.getState().setToggle(inst.id, !cur);
          return;
        }
      }

      if (tool === 'pan' || spaceHeld || e.button === 1) {
        onBackgroundPointerDown(e);
        return;
      }
      if (s.wireDraft) return;

      const already = s.selection.componentIds.includes(inst.id);
      if (e.shiftKey) {
        s.setSelection({
          componentIds: already
            ? s.selection.componentIds.filter((id) => id !== inst.id)
            : [...s.selection.componentIds, inst.id],
          connectionIds: s.selection.connectionIds,
        });
      } else if (!already) {
        s.setSelection({ componentIds: [inst.id], connectionIds: [] });
      }
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      dragRef.current = {
        kind: 'move',
        startClient: { x: e.clientX, y: e.clientY },
        lastWorld: toWorld(e.clientX, e.clientY),
        moved: false,
      };
    },
    [store, tool, spaceHeld, toWorld, definitions, onBackgroundPointerDown],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const s = store.getState();
      if (s.wireDraft) {
        const world = toWorld(e.clientX, e.clientY);
        s.setWireDraft({ ...s.wireDraft, cursor: world });
      }
      const drag = dragRef.current;
      if (!drag) return;
      const world = toWorld(e.clientX, e.clientY);
      if (drag.kind === 'pan' && drag.startView) {
        const dxClient = e.clientX - drag.startClient.x;
        const dyClient = e.clientY - drag.startClient.y;
        s.setView({
          x: drag.startView.x - dxClient / drag.startView.zoom,
          y: drag.startView.y - dyClient / drag.startView.zoom,
          zoom: drag.startView.zoom,
        });
      } else if (drag.kind === 'move') {
        const dx = snap(world.x) - snap(drag.lastWorld.x);
        const dy = snap(world.y) - snap(drag.lastWorld.y);
        if (dx !== 0 || dy !== 0) {
          drag.moved = true;
          s.moveInstances(s.selection.componentIds, dx, dy, false);
          drag.lastWorld = { x: drag.lastWorld.x + dx, y: drag.lastWorld.y + dy };
        }
      } else if (drag.kind === 'box' && drag.boxStart) {
        drag.moved = true;
        setBoxRect({
          x: Math.min(drag.boxStart.x, world.x),
          y: Math.min(drag.boxStart.y, world.y),
          w: Math.abs(world.x - drag.boxStart.x),
          h: Math.abs(world.y - drag.boxStart.y),
        });
      }
    },
    [store, toWorld],
  );

  const onPointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    const s = store.getState();
    if (!drag) return;
    if (drag.kind === 'move' && drag.moved) {
      s.moveInstances(s.selection.componentIds, 0, 0, true);
    } else if (drag.kind === 'box' && boxRect) {
      const hit = instances
        .filter((inst) => {
          const def = definitions.get(inst.id);
          if (!def) return false;
          const b = partBounds(inst, def);
          return b.x < boxRect.x + boxRect.w && b.x + b.w > boxRect.x && b.y < boxRect.y + boxRect.h && b.y + b.h > boxRect.y;
        })
        .map((i) => i.id);
      if (hit.length > 0) {
        s.setSelection({ componentIds: [...new Set([...s.selection.componentIds, ...hit])], connectionIds: [] });
      }
    }
    setBoxRect(null);
  }, [store, boxRect, instances, definitions]);

  // wire endpoints resolver
  const pinPos = useCallback(
    (componentId: string, pinId: string): Pt | null => {
      const inst = instances.find((i) => i.id === componentId);
      const def = inst ? definitions.get(inst.id) : undefined;
      const pin = def?.pins.find((p) => p.id === pinId);
      if (!inst || !def || !pin) return null;
      return pinAbsolute(inst, def, pin);
    },
    [instances, definitions],
  );

  const issueHighlights = useMemo(() => {
    if (!highlightedIssueId) return { comps: new Set<string>(), conns: new Set<string>() };
    const issue = validationIssues.find((i) => i.id === highlightedIssueId);
    return {
      comps: new Set(issue?.affectedComponentIds ?? []),
      conns: new Set(issue?.affectedConnectionIds ?? []),
    };
  }, [highlightedIssueId, validationIssues]);

  if (!project) return null;

  const vb = `${view.x} ${view.y} ${size.w / view.zoom} ${size.h / view.zoom}`;
  const cursor = spaceHeld || tool === 'pan' ? 'grab' : wireDraft ? 'crosshair' : tool === 'wire' ? 'crosshair' : 'default';

  return (
    <div
      ref={wrapRef}
      className="canvas-wrap"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('circuitdesk/part')) e.preventDefault();
      }}
      onDrop={(e) => {
        const defId = e.dataTransfer.getData('circuitdesk/part');
        if (!defId) return;
        e.preventDefault();
        const world = toWorld(e.clientX, e.clientY);
        const def = resolveDefinition(defId, project);
        const { w, h } = def ? partSize(def) : { w: 40, h: 40 };
        useEditorStore.getState().addInstance(defId, snap(world.x - w / 2), snap(world.y - h / 2));
      }}
    >
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        viewBox={vb}
        style={{ cursor, display: 'block' }}
        onWheel={onWheel}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => {
          if (useEditorStore.getState().wireDraft) {
            e.preventDefault();
            useEditorStore.getState().setWireDraft(null);
          }
        }}
      >
        <defs>
          <pattern id="grid" width="25" height="25" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="#232d3a" />
          </pattern>
          <pattern id="grid-major" width="125" height="125" patternUnits="userSpaceOnUse">
            <rect width="125" height="125" fill="url(#grid)" />
            <circle cx="1" cy="1" r="1.6" fill="#2e3b4b" />
          </pattern>
        </defs>
        <rect
          x={view.x - 10}
          y={view.y - 10}
          width={size.w / view.zoom + 20}
          height={size.h / view.zoom + 20}
          fill="url(#grid-major)"
        />

        <WiresLayer
          project={project}
          pinPos={pinPos}
          selection={selection.connectionIds}
          highlighted={issueHighlights.conns}
        />

        {instances.map((inst) => (
          <PartView
            key={inst.id}
            inst={inst}
            def={definitions.get(inst.id)}
            selected={selection.componentIds.includes(inst.id)}
            issueHighlight={issueHighlights.comps.has(inst.id)}
            zoom={view.zoom}
            onPointerDown={onPartPointerDown}
            onPinClick={onPinClick}
          />
        ))}

        <WireDraftLayer pinPos={pinPos} />

        {boxRect && (
          <rect
            x={boxRect.x} y={boxRect.y} width={boxRect.w} height={boxRect.h}
            fill="rgba(61,157,242,0.08)" stroke="#3d9df2" strokeWidth={1 / view.zoom} strokeDasharray={`${4 / view.zoom}`}
          />
        )}
      </svg>

      <PinTooltip toWorldRect={() => svgRef.current?.getBoundingClientRect() ?? null} />
      <Minimap instances={instances} definitions={definitions} size={size} />
    </div>
  );
}

// ---------------- wires ----------------

const WiresLayer = memo(function WiresLayer({
  project,
  pinPos,
  selection,
  highlighted,
}: {
  project: CircuitProject;
  pinPos: (c: string, p: string) => Pt | null;
  selection: string[];
  highlighted: Set<string>;
}) {
  const frame = useSimulationStore((s) => s.frame);
  const status = useSimulationStore((s) => s.status);

  // net activity: map connection -> high/low when simulating
  const graph = useMemo(() => buildCircuitGraph(project), [project]);
  const activity = useMemo(() => {
    void frame;
    const snapshot = useSimulationStore.getState().pinSnapshot;
    const map = new Map<string, boolean>();
    if (!snapshot || status === 'stopped') return map;
    const board = project.boardInstances[0];
    if (!board) return map;
    for (const conn of project.connections) {
      const netId = graph.netOf.get(`${conn.sourceComponentId}:${conn.sourcePinId}`);
      if (!netId) continue;
      const net = graph.nets.find((n) => n.id === netId);
      if (!net) continue;
      for (const node of net.nodes) {
        const [instId, pinId] = node.split(/:(.+)/s) as unknown as [string, string];
        if (instId === board.id) {
          const boardDef = graph.definitions.get(board.id);
          const arduinoPin = boardDef?.isBoard ? arduinoPinNumber(boardDef, pinId) : undefined;
          if (arduinoPin !== undefined && snapshot.states[arduinoPin] === 'high') {
            map.set(conn.id, true);
            break;
          }
        }
      }
    }
    return map;
  }, [frame, status, project, graph]);

  const store = useEditorStore;
  return (
    <g>
      {project.connections.map((conn) => {
        const a = pinPos(conn.sourceComponentId, conn.sourcePinId);
        const b = pinPos(conn.targetComponentId, conn.targetPinId);
        if (!a || !b) return null;
        const d = wirePath(a, b, conn.points, conn.routing);
        const selected = selection.includes(conn.id);
        const active = activity.get(conn.id);
        const issueHl = highlighted.has(conn.id);
        return (
          <g key={conn.id}>
            <path d={d} stroke="transparent" strokeWidth="10" fill="none" style={{ cursor: 'pointer' }}
              onPointerDown={(e) => {
                e.stopPropagation();
                const s = store.getState();
                if (e.shiftKey) {
                  s.setSelection({
                    componentIds: s.selection.componentIds,
                    connectionIds: selected
                      ? s.selection.connectionIds.filter((id) => id !== conn.id)
                      : [...s.selection.connectionIds, conn.id],
                  });
                } else {
                  s.setSelection({ componentIds: [], connectionIds: [conn.id] });
                }
              }}
            />
            <path d={d} stroke="rgba(0,0,0,0.4)" strokeWidth="4.6" fill="none" strokeLinecap="round" opacity="0.5" transform="translate(0.8 1.2)" />
            {active && <path d={d} stroke={conn.color} strokeWidth="7" fill="none" strokeLinecap="round" opacity="0.32" />}
            <path
              d={d}
              stroke={issueHl ? '#f85149' : conn.color}
              strokeWidth={selected ? 4.4 : 3.4}
              fill="none"
              strokeLinecap="round"
              opacity={active ? 1 : 0.92}
            />
            {selected && <path d={d} stroke="#3d9df2" strokeWidth="1.2" strokeDasharray="5 4" fill="none" />}
            <circle cx={a.x} cy={a.y} r="2.6" fill={conn.color} stroke="rgba(0,0,0,0.4)" strokeWidth="0.7" />
            <circle cx={b.x} cy={b.y} r="2.6" fill={conn.color} stroke="rgba(0,0,0,0.4)" strokeWidth="0.7" />
            {conn.label && (
              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} fontSize="9" fill="#a8b3bf" textAnchor="middle">
                {conn.label}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
});

function WireDraftLayer({ pinPos }: { pinPos: (c: string, p: string) => Pt | null }) {
  const draft = useEditorStore((s) => s.wireDraft);
  if (!draft || !draft.cursor) return null;
  const from = pinPos(draft.fromComponentId, draft.fromPinId);
  if (!from) return null;
  const d = wirePath(from, draft.cursor, draft.points, 'smooth');
  return (
    <g pointerEvents="none">
      <path d={d} stroke="#3d9df2" strokeWidth="3" fill="none" strokeLinecap="round" strokeDasharray="7 5" opacity="0.9" />
      <circle cx={from.x} cy={from.y} r="3.4" fill="#3d9df2" />
    </g>
  );
}

// ---------------- parts ----------------

const PartView = memo(function PartView({
  inst,
  def,
  selected,
  issueHighlight,
  zoom,
  onPointerDown,
  onPinClick,
}: {
  inst: ComponentInstance;
  def: PartDefinition | undefined;
  selected: boolean;
  issueHighlight: boolean;
  zoom: number;
  onPointerDown: (inst: ComponentInstance, e: React.PointerEvent) => void;
  onPinClick: (componentId: string, pin: PinDefinition, e: React.MouseEvent) => void;
}) {
  const visual = useSimulationStore((s) => s.visuals[inst.id]);
  const hoveredPin = useEditorStore((s) => s.hoveredPin);
  const wireDraft = useEditorStore((s) => s.wireDraft);

  if (!def) {
    return (
      <g transform={`translate(${inst.x} ${inst.y})`}>
        <rect width="60" height="40" rx="4" fill="#3a2222" stroke="#6e2724" />
        <text x="30" y="24" fontSize="8" fill="#ff8a80" textAnchor="middle">missing def</text>
      </g>
    );
  }

  const { w, h } = partSize(def);
  const showPinLabels = zoom > 1.5;
  const isBoard = Boolean(def.isBoard);
  const pinRadius = isBoard ? 3.6 : 3.1;

  return (
    <g
      transform={`translate(${inst.x} ${inst.y}) rotate(${inst.rotation} ${w / 2} ${h / 2})`}
      onPointerDown={(e) => onPointerDown(inst, e)}
      style={{ cursor: 'move' }}
    >
      {def.isBoard ? (
        def.artwork.builtinId === 'arduino-uno' ? (
          <UnoArtwork def={def} />
        ) : def.artwork.builtinId === 'arduino-mega' ? (
          <MegaArtwork def={def} />
        ) : (
          <GenericModuleArtwork def={def} />
        )
      ) : (
        <ComponentArtwork def={def} instance={inst} visual={visual} />
      )}

      {(selected || issueHighlight) && (
        <rect
          x={-5} y={-5} width={w + 10} height={h + 10} rx="6"
          fill="none"
          stroke={issueHighlight ? '#f85149' : '#3d9df2'}
          strokeWidth={1.6 / Math.max(zoom, 0.4)}
          strokeDasharray={issueHighlight ? '4 3' : undefined}
        />
      )}

      {/* interactive pins */}
      {def.pins.map((pin) => {
        const hovered = hoveredPin?.componentId === inst.id && hoveredPin.pinId === pin.id;
        const wiring = Boolean(wireDraft);
        return (
          <g key={pin.id}>
            <circle
              cx={pin.x}
              cy={pin.y}
              r={hovered ? pinRadius + 1.6 : pinRadius}
              fill={hovered ? 'rgba(61,157,242,0.85)' : wiring ? 'rgba(63,185,80,0.55)' : 'rgba(255,255,255,0.001)'}
              stroke={hovered ? '#8fd0ff' : wiring ? '#3fb950' : 'transparent'}
              strokeWidth="1"
              style={{ cursor: 'crosshair' }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => onPinClick(inst.id, pin, e)}
              onPointerEnter={() => useEditorStore.getState().setHoveredPin({ componentId: inst.id, pinId: pin.id })}
              onPointerLeave={() => useEditorStore.getState().setHoveredPin(null)}
            />
            {showPinLabels && !isBoard && hovered && (
              <text x={pin.x} y={pin.y - 6} fontSize="7" fill="#cfe6ff" textAnchor="middle" pointerEvents="none">
                {pin.label}
              </text>
            )}
          </g>
        );
      })}

      {inst.label && (
        <text x={w / 2} y={-8} fontSize="10" fill="#a8b3bf" textAnchor="middle" pointerEvents="none">
          {inst.label}
        </text>
      )}
    </g>
  );
});

// ---------------- pin tooltip ----------------

function PinTooltip({ toWorldRect }: { toWorldRect: () => DOMRect | null }) {
  const hoveredPin = useEditorStore((s) => s.hoveredPin);
  const project = useEditorStore((s) => s.project);
  const view = useEditorStore((s) => s.view);
  const simStatus = useSimulationStore((s) => s.status);
  const pinSnapshot = useSimulationStore((s) => s.pinSnapshot);

  const data = useMemo(() => {
    if (!hoveredPin || !project) return null;
    const inst = [...project.boardInstances, ...project.componentInstances].find((i) => i.id === hoveredPin.componentId);
    const def = inst ? resolveDefinition(inst.definitionId, project) : undefined;
    const pin = def?.pins.find((p) => p.id === hoveredPin.pinId);
    if (!inst || !def || !pin) return null;
    const abs = pinAbsolute(inst, def, pin);
    const connections = project.connections.filter(
      (c) =>
        (c.sourceComponentId === inst.id && c.sourcePinId === pin.id) ||
        (c.targetComponentId === inst.id && c.targetPinId === pin.id),
    );
    let simState: string | null = null;
    if (def.isBoard && simStatus !== 'stopped' && pinSnapshot) {
      const n = arduinoPinNumber(def, pin.id);
      if (n !== undefined && n < pinSnapshot.states.length) {
        const st = pinSnapshot.states[n];
        const duty = pinSnapshot.duty[n];
        simState = st === 'high' || st === 'low' ? `${st.toUpperCase()}${duty > 0.02 && duty < 0.98 && st === 'high' ? ` (PWM ${(duty * 100).toFixed(0)}%)` : ''}` : st;
      }
    }
    return { inst, def, pin, abs, connections, simState };
  }, [hoveredPin, project, simStatus, pinSnapshot]);

  if (!data) return null;
  const rect = toWorldRect();
  if (!rect) return null;
  const sx = (data.abs.x - view.x) * view.zoom;
  const sy = (data.abs.y - view.y) * view.zoom;
  if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) return null;

  const { pin, connections, simState } = data;
  return (
    <div className="pin-tooltip" style={{ left: Math.min(sx + 14, rect.width - 270), top: Math.max(sy - 10, 8) }}>
      <div className="pt-title">
        {pin.label}
        {pin.number ? ` (pin ${pin.number})` : ''}
      </div>
      <div className="pt-row">Type: <b>{pin.type}</b></div>
      {pin.voltage !== undefined && <div className="pt-row">Voltage: <b>{pin.voltage} V</b></div>}
      {pin.maxCurrentMa !== undefined && <div className="pt-row">Max current: <b>{pin.maxCurrentMa} mA</b></div>}
      {pin.capabilities.length > 0 && (
        <div className="pt-row">Capabilities: <b>{pin.capabilities.join(', ')}</b></div>
      )}
      <div className="pt-row">
        Connections: <b>{connections.length === 0 ? 'none' : connections.length}</b>
      </div>
      {simState && <div className="pt-row">Simulation: <b>{simState}</b></div>}
      {pin.description && <div className="pt-row">{pin.description}</div>}
    </div>
  );
}

// ---------------- minimap ----------------

const Minimap = memo(function Minimap({
  instances,
  definitions,
  size,
}: {
  instances: ComponentInstance[];
  definitions: Map<string, PartDefinition>;
  size: { w: number; h: number };
}) {
  const view = useEditorStore((s) => s.view);
  if (instances.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const inst of instances) {
    const def = definitions.get(inst.id);
    if (!def) continue;
    const b = partBounds(inst, def);
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  const pad = 100;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const MW = 148, MH = 104;
  const scale = Math.min(MW / (maxX - minX), MH / (maxY - minY));

  return (
    <svg
      className="minimap"
      width={MW}
      height={MH}
      onPointerDown={(e) => {
        const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const wx = minX + (e.clientX - rect.left) / scale;
        const wy = minY + (e.clientY - rect.top) / scale;
        const s = useEditorStore.getState();
        s.setView({ x: wx - size.w / s.view.zoom / 2, y: wy - size.h / s.view.zoom / 2, zoom: s.view.zoom });
      }}
    >
      {instances.map((inst) => {
        const def = definitions.get(inst.id);
        if (!def) return null;
        const b = partBounds(inst, def);
        return (
          <rect
            key={inst.id}
            x={(b.x - minX) * scale}
            y={(b.y - minY) * scale}
            width={Math.max(2, b.w * scale)}
            height={Math.max(2, b.h * scale)}
            fill={def.isBoard ? '#2b7bb5' : '#5c6a76'}
            rx="1"
          />
        );
      })}
      <rect
        x={(view.x - minX) * scale}
        y={(view.y - minY) * scale}
        width={(size.w / view.zoom) * scale}
        height={(size.h / view.zoom) * scale}
        fill="rgba(61,157,242,0.1)"
        stroke="#3d9df2"
        strokeWidth="1"
      />
    </svg>
  );
});
