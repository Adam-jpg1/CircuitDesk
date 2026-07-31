import { useCallback, useEffect } from 'react';
import { useEditorStore } from '../app/editorStore';
import { useSimulationStore } from '../simulation/simulationStore';
import { simulationController } from '../simulation/simulationController';
import { compileAction, runAction } from '../app/actions';
import { CanvasStage } from '../canvas/CanvasStage';
import { Toolbar } from './Toolbar';
import { LibraryPanel } from './LibraryPanel';
import { Inspector } from './Inspector';
import { BottomPanel } from './BottomPanel';
import { layoutCodeEditor } from './CodePanel';
import { ErrorBoundary, ResizeHandle, navigate } from '../ui/primitives';
import { PANEL_LIMITS } from '../persistence/settings';
import { CollapseLeftIcon, CollapseRightIcon } from '../ui/icons';

export function EditorShell({ projectId }: { projectId: string }) {
  const project = useEditorStore((s) => s.project);
  const loading = useEditorStore((s) => s.loading);
  const loadError = useEditorStore((s) => s.loadError);
  const panelSizes = useEditorStore((s) => s.panelSizes);

  useEffect(() => {
    void useEditorStore.getState().load(projectId);
  }, [projectId]);

  // stop the simulation when leaving the editor entirely
  useEffect(() => {
    return () => {
      simulationController.stop();
      useSimulationStore.getState().resetInputs();
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

  useKeyboardShortcuts();

  useEffect(() => {
    layoutCodeEditor();
  }, [panelSizes]);

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
