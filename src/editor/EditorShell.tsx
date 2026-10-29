import { useCallback, useEffect, useState } from 'react';
import { useEditorStore } from '../app/editorStore';
import { useSimulationStore } from '../simulation/simulationStore';
import { simulationController } from '../simulation/simulationController';
import { compileAction, runAction } from '../app/actions';
import { startBackgroundBuilds } from '../app/backgroundBuild';
import { CanvasStage } from '../canvas/CanvasStage';
import { Toolbar } from './Toolbar';
import { LibraryPanel } from './LibraryPanel';
import { Inspector } from './Inspector';
import { BottomPanel } from './BottomPanel';
import { KeyMatrixOverlay } from './KeyMatrixOverlay';
import { layoutCodeEditor } from './CodePanel';
import { ErrorBoundary, ResizeHandle, navigate } from '../ui/primitives';
import { PANEL_LIMITS } from '../persistence/settings';
import { CollapseLeftIcon, CollapseRightIcon } from '../ui/icons';
import { useIsPhone, usePhoneLayout, type PhonePane } from './phoneLayout';

export function EditorShell({ projectId }: { projectId: string }) {
  const project = useEditorStore((s) => s.project);
  const loading = useEditorStore((s) => s.loading);
  const loadError = useEditorStore((s) => s.loadError);
  const panelSizes = useEditorStore((s) => s.panelSizes);
  const phone = useIsPhone();
  const pane = usePhoneLayout((s) => s.pane);

  useEffect(() => {
    void useEditorStore.getState().load(projectId);
  }, [projectId]);

  // Tear the simulation down when leaving this project — including when the
  // route moves to a *different* project, which remounts this component. A new
  // project must not open showing the previous one's serial log, build report
  // or input state.
  useEffect(() => {
    return () => {
      simulationController.closeProject();
    };
  }, []);

  // keep the live simulation's circuit binding in sync with wiring edits, and
  // let the controller stop the run when the board itself is swapped
  const connections = project?.connections;
  const componentInstances = project?.componentInstances;
  const boardInstances = project?.boardInstances;
  useEffect(() => {
    const p = useEditorStore.getState().project;
    if (p && useSimulationStore.getState().status !== 'stopped') {
      simulationController.refreshCircuit(p);
    }
  }, [connections, componentInstances, boardInstances]);

  // Compile in the background once the code has been still for a moment, so
  // Run finds the firmware ready instead of starting the toolchain then.
  useEffect(() => startBackgroundBuilds(), [projectId]);

  useKeyboardShortcuts();
  usePageZoomGuard();

  useEffect(() => {
    layoutCodeEditor();
  }, [panelSizes, phone, pane]);

  // A project opens on its circuit.
  useEffect(() => usePhoneLayout.getState().setPane('circuit'), [projectId]);

  if (loadError) {
    return (
      <div className="error-boundary">
        <h3>Could not open this project</h3>
        <p>{loadError}</p>
        <button className="btn primary" onClick={() => navigate('#/')}>Back to dashboard</button>
      </div>
    );
  }
  if (loading || !project) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <div className="spinner" />
        <p>Opening project…</p>
      </div>
    );
  }

  if (phone) return <PhoneEditor />;

  const s = useEditorStore.getState();
  const maxBottom = Math.round(window.innerHeight * (PANEL_LIMITS.bottom.maxVh / 100));

  return (
    <div className="editor-root">
      <Toolbar />
      <div className="editor-main">
        {!panelSizes.leftCollapsed && (
          <>
            <div className="side-panel left" style={{ width: panelSizes.left }}>
              <ErrorBoundary name="library panel">
                <LibraryPanel />
              </ErrorBoundary>
            </div>
            <ResizeHandle
              direction="vertical"
              onDelta={(d) =>
                s.setPanelSizes({
                  left: Math.min(PANEL_LIMITS.left.max, Math.max(PANEL_LIMITS.left.min, useEditorStore.getState().panelSizes.left + d)),
                })
              }
            />
          </>
        )}
        <div className="editor-center">
          <ErrorBoundary name="canvas">
            <CanvasStage />
          </ErrorBoundary>
          <ErrorBoundary name="key panel">
            <KeyPanelHost />
          </ErrorBoundary>
          {!panelSizes.bottomCollapsed && (
            <>
              <ResizeHandle
                direction="horizontal"
                onDelta={(d) =>
                  s.setPanelSizes({
                    bottom: Math.min(maxBottom, Math.max(PANEL_LIMITS.bottom.min, useEditorStore.getState().panelSizes.bottom - d)),
                  })
                }
                onDone={layoutCodeEditor}
              />
              <div style={{ height: panelSizes.bottom, display: 'flex', minHeight: 0, flexShrink: 0 }}>
                <ErrorBoundary name="bottom panel (code / serial / simulation)">
                  <BottomPanel />
                </ErrorBoundary>
              </div>
            </>
          )}
        </div>
        {!panelSizes.rightCollapsed && (
          <>
            <ResizeHandle
              direction="vertical"
              onDelta={(d) =>
                s.setPanelSizes({
                  right: Math.min(PANEL_LIMITS.right.max, Math.max(PANEL_LIMITS.right.min, useEditorStore.getState().panelSizes.right - d)),
                })
              }
            />
            <div className="side-panel right" style={{ width: panelSizes.right }}>
              <ErrorBoundary name="inspector">
                <Inspector />
              </ErrorBoundary>
            </div>
          </>
        )}
      </div>
      <StatusBar />
    </div>
  );
}

/**
 * The editor on a phone: one pane at a time, full size, and a tab bar to move
 * between them. The canvas stays mounted underneath the other panes, so the
 * view, a wire in progress and a running simulation are where they were when
 * you come back to it.
 */
function PhoneEditor() {
  const pane = usePhoneLayout((s) => s.pane);
  const [visited, setVisited] = useState<Set<PhonePane>>(() => new Set([pane]));
  useEffect(() => {
    setVisited((v) => (v.has(pane) ? v : new Set([...v, pane])));
  }, [pane]);
  const selected = useEditorStore((s) => s.selection.componentIds.length + s.selection.connectionIds.length);
  const serialLines = useSimulationStore((s) => s.serialLineCount);
  const tabs: { id: PhonePane; label: string; badge?: boolean }[] = [
    { id: 'circuit', label: 'Circuit' },
    { id: 'parts', label: 'Parts' },
    { id: 'code', label: 'Code', badge: serialLines > 0 },
    { id: 'inspect', label: 'Inspect', badge: selected > 0 },
  ];
  return (
    <div className="editor-root phone">
      <Toolbar phone />
      <div className="editor-main">
        <div className="editor-center">
          <ErrorBoundary name="canvas">
            <CanvasStage />
          </ErrorBoundary>
          <ErrorBoundary name="key panel">
            <KeyPanelHost />
          </ErrorBoundary>
          {pane === 'circuit' && <PhoneCanvasTools />}
          {/* A pane stays mounted once opened and is only hidden after: the
              code editor keeps its cursor, scroll and undo history, and is
              not torn down and rebuilt on every tab switch. */}
          {(['parts', 'code', 'inspect'] as const).map((id) =>
            visited.has(id) ? (
              <div key={id} className={`phone-pane phone-pane-${id}`} hidden={pane !== id}>
                {id === 'parts' && (
                  <ErrorBoundary name="library panel">
                    <LibraryPanel />
                  </ErrorBoundary>
                )}
                {id === 'code' && (
                  <ErrorBoundary name="bottom panel (code / serial / simulation)">
                    <BottomPanel />
                  </ErrorBoundary>
                )}
                {id === 'inspect' && (
                  <ErrorBoundary name="inspector">
                    <Inspector />
                  </ErrorBoundary>
                )}
              </div>
            ) : null,
          )}
        </div>
      </div>
      <nav className="phone-tabs" aria-label="Editor panes">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`phone-tab${pane === t.id ? ' active' : ''}`}
            aria-current={pane === t.id ? 'page' : undefined}
            onClick={() => usePhoneLayout.getState().setPane(t.id)}
          >
            {t.label}
            {t.badge && pane !== t.id && <span className="phone-tab-dot" />}
          </button>
        ))}
      </nav>
    </div>
  );
}

/**
 * What the keyboard shortcuts do on a desktop, as buttons over the canvas:
 * there is no V, W, R or Escape on a phone.
 */
function PhoneCanvasTools() {
  const tool = useEditorStore((s) => s.tool);
  const wireDraft = useEditorStore((s) => s.wireDraft);
  const selection = useEditorStore((s) => s.selection);
  const undoDepth = useEditorStore((s) => s.undoDepth);
  const s = useEditorStore.getState();
  const hasSelection = selection.componentIds.length > 0 || selection.connectionIds.length > 0;
  return (
    <>
      <div className="phone-canvas-tools" role="toolbar" aria-label="Canvas tools">
        <button className={`phone-tool${tool === 'select' ? ' active' : ''}`} onClick={() => s.setTool('select')}>Move</button>
        <button className={`phone-tool${tool === 'wire' ? ' active' : ''}`} onClick={() => s.setTool('wire')}>Wire</button>
        <button className="phone-tool" disabled={selection.componentIds.length === 0} onClick={() => s.rotateSelection()}>Rotate</button>
        <button className="phone-tool" disabled={!hasSelection} onClick={() => s.deleteSelection()}>Delete</button>
        <button className="phone-tool" disabled={undoDepth === 0} onClick={() => s.undo()}>Undo</button>
        <button className="phone-tool" onClick={() => (window as unknown as { __cdFit?: () => void }).__cdFit?.()}>Fit</button>
      </div>
      {wireDraft && (
        <div className="phone-wire-hint">
          <span>Tap another pin to connect, or empty space to bend the wire.</span>
          <button className="btn sm" onClick={() => s.setWireDraft(null)}>Cancel</button>
        </div>
      )}
    </>
  );
}

/** The full-size key panel, when one is open on a keypad or keyboard. */
function KeyPanelHost() {
  const instanceId = useEditorStore((s) => s.keyPanelInstanceId);
  if (!instanceId) return null;
  return <KeyMatrixOverlay instanceId={instanceId} onClose={() => useEditorStore.getState().setKeyPanel(null)} />;
}

function StatusBar() {
  const project = useEditorStore((s) => s.project);
  const panelSizes = useEditorStore((s) => s.panelSizes);
  const view = useEditorStore((s) => s.view);
  const status = useSimulationStore((s) => s.status);
  const simTimeMs = useSimulationStore((s) => s.simTimeMs);
  const speedFactor = useSimulationStore((s) => s.speedFactor);
  const lastCompile = useEditorStore((s) => s.lastCompile);
  const s = useEditorStore.getState();

  return (
    <div className="status-bar">
      <button
        className="icon-btn"
        style={{ width: 20, height: 20 }}
        title={panelSizes.leftCollapsed ? 'Show library' : 'Hide library'}
        onClick={() => s.setPanelSizes({ leftCollapsed: !panelSizes.leftCollapsed })}
      >
        <CollapseLeftIcon style={{ width: 13, height: 13, transform: panelSizes.leftCollapsed ? 'scaleX(-1)' : undefined }} />
      </button>
      <span>
        {project ? `${project.boardInstances.length + project.componentInstances.length} parts · ${project.connections.length} wires` : ''}
      </span>
      <span>Zoom {(view.zoom * 100).toFixed(0)}%</span>
      <span className={status === 'running' ? 'sim-running' : status === 'paused' ? 'sim-paused' : ''}>
        {status === 'running'
          ? `Simulating — ${(simTimeMs / 1000).toFixed(1)} s @ ${(speedFactor * 100).toFixed(0)}%`
          : status === 'paused'
            ? `Paused @ ${(simTimeMs / 1000).toFixed(2)} s`
            : status === 'error'
              ? 'Simulation error'
              : 'Simulation stopped'}
      </span>
      {lastCompile?.memory && (
        <span>flash {Math.round((lastCompile.memory.flashBytes / lastCompile.memory.flashMaxBytes) * 100)}%</span>
      )}
      <span className="spacer" />
      <span>V select · W wire · H/Space pan · R rotate · F fit · Ctrl+Enter run</span>
      <button
        className="icon-btn"
        style={{ width: 20, height: 20 }}
        title={panelSizes.bottomCollapsed ? 'Show bottom panel' : 'Hide bottom panel'}
        onClick={() => s.setPanelSizes({ bottomCollapsed: !panelSizes.bottomCollapsed })}
      >
        ▁
      </button>
      <button
        className="icon-btn"
        style={{ width: 20, height: 20 }}
        title={panelSizes.rightCollapsed ? 'Show inspector' : 'Hide inspector'}
        onClick={() => s.setPanelSizes({ rightCollapsed: !panelSizes.rightCollapsed })}
      >
        <CollapseRightIcon style={{ width: 13, height: 13, transform: panelSizes.rightCollapsed ? 'scaleX(-1)' : undefined }} />
      </button>
    </div>
  );
}

function useKeyboardShortcuts() {
  const handler = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.closest('.monaco-editor') !== null;
    const s = useEditorStore.getState();

    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runAction();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      s.markDirtyAndSave();
      return;
    }
    if (typing) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      s.undo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      s.redo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      s.copySelection();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      s.pasteClipboard();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      s.deleteSelection();
    } else if (e.key === 'Escape') {
      if (s.wireDraft) s.setWireDraft(null);
      else s.setSelection({ componentIds: [], connectionIds: [] });
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      switch (e.key.toLowerCase()) {
        case 'v': s.setTool('select'); break;
        case 'w': s.setTool('wire'); break;
        case 'h': s.setTool('pan'); break;
        case 'r': s.rotateSelection(); break;
        case 'f': (window as unknown as { __cdFit?: () => void }).__cdFit?.(); break;
        default: return;
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handler]);
}

// re-export for actions module (avoids a cycle warning in some bundlers)
export { compileAction };

/**
 * Keeps the browser's own page zoom out of the editor. A trackpad pinch
 * arrives as a wheel event with Ctrl held (Safari: as gesture events), and
 * one that landed anywhere but the canvas — a panel, the toolbar, the gap
 * between them — zoomed the whole app. The canvas zooms itself and cancels
 * the event; everywhere else in the editor it is simply cancelled. Ctrl/Cmd
 * with + or - is left alone: that is a deliberate request for page zoom.
 */
function usePageZoomGuard() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    const onGesture = (e: Event) => e.preventDefault();
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('gesturestart', onGesture);
    window.addEventListener('gesturechange', onGesture);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('gesturestart', onGesture);
      window.removeEventListener('gesturechange', onGesture);
    };
  }, []);
}
