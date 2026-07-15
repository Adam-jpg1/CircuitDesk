import { useState } from 'react';
import { useEditorStore } from '../app/editorStore';
import { useSimulationStore } from '../simulation/simulationStore';
import { simulationController } from '../simulation/simulationController';
import { compileAction, runAction, validateAction } from '../app/actions';
import { navigate, Modal, toast } from '../ui/primitives';
import {
  BackIcon, CheckShieldIcon, CursorIcon, ExportIcon, FitIcon, HammerIcon, LogoIcon, PanIcon,
  PauseIcon, PlayIcon, RedoIcon, ResetIcon, RotateIcon, StepIcon, StopIcon, TrashIcon,
  UndoIcon, WireIcon, ZoomInIcon, ZoomOutIcon,
} from '../ui/icons';
import {
  exportProjectJson, exportProjectZip, buildBomCsv, buildPinMapCsv, buildWiringReport,
  buildValidationReport, exportBoardDefinition, exportProjectImage,
} from '../project/exporters';
import { downloadFile } from '../ui/primitives';
import { testResultsCache } from './TestsPanel';

export function Toolbar() {
  const project = useEditorStore((s) => s.project);
  const tool = useEditorStore((s) => s.tool);
  const saveState = useEditorStore((s) => s.saveState);
  const compiling = useEditorStore((s) => s.compiling);
  const undoDepth = useEditorStore((s) => s.undoDepth);
  const redoDepth = useEditorStore((s) => s.redoDepth);
  const selection = useEditorStore((s) => s.selection);
  const simStatus = useSimulationStore((s) => s.status);
  const [exportOpen, setExportOpen] = useState(false);

  if (!project) return null;
  const s = useEditorStore.getState();
  const hasSelection = selection.componentIds.length > 0 || selection.connectionIds.length > 0;

  const zoomBy = (f: number) => {
    const v = s.view;
    s.setView({ ...v, zoom: Math.min(4, Math.max(0.12, v.zoom * f)) });
  };

  return (
    <div className="toolbar">
      <button className="icon-btn" title="Back to dashboard" onClick={() => { s.closeProject(); navigate('#/'); }}>
        <BackIcon />
      </button>
      <span className="brand"><LogoIcon /> CircuitDesk</span>
      <input
        className="project-name"
        defaultValue={project.name}
        key={project.id + project.name}
        title="Project name (click to rename)"
        onBlur={(e) => e.target.value !== project.name && s.renameProject(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span className={`save-status ${saveState}`}>
        {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Unsaved'}
      </span>

      <div className="sep" />
      <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={undoDepth === 0} onClick={() => s.undo()}><UndoIcon /></button>
      <button className="icon-btn" title="Redo (Ctrl+Y)" disabled={redoDepth === 0} onClick={() => s.redo()}><RedoIcon /></button>

      <div className="sep" />
      <button className={`icon-btn ${tool === 'select' ? 'active' : ''}`} title="Select (V)" onClick={() => s.setTool('select')}><CursorIcon /></button>
      <button className={`icon-btn ${tool === 'wire' ? 'active' : ''}`} title="Wire (W) — click a pin to start" onClick={() => s.setTool('wire')}><WireIcon /></button>
      <button className={`icon-btn ${tool === 'pan' ? 'active' : ''}`} title="Pan (H, or hold Space)" onClick={() => s.setTool('pan')}><PanIcon /></button>
      <button className="icon-btn" title="Rotate selection (R)" disabled={selection.componentIds.length === 0} onClick={() => s.rotateSelection()}><RotateIcon /></button>
      <button className="icon-btn" title="Delete selection (Del)" disabled={!hasSelection} onClick={() => s.deleteSelection()}><TrashIcon /></button>

      <div className="sep" />
      <button className="icon-btn" title="Zoom in" onClick={() => zoomBy(1.2)}><ZoomInIcon /></button>
      <button className="icon-btn" title="Zoom out" onClick={() => zoomBy(1 / 1.2)}><ZoomOutIcon /></button>
      <button className="icon-btn" title="Fit to view (F)" onClick={() => (window as unknown as { __cdFit?: () => void }).__cdFit?.()}><FitIcon /></button>

      <div className="sep" />
      <button className="btn sm" title="Run electrical + code validation" onClick={validateAction}>
        <CheckShieldIcon style={{ width: 14, height: 14 }} /> Validate
      </button>
      <button className="btn sm" title="Compile with the real toolchain (Arduino CLI / avr-g++)" disabled={compiling} onClick={() => void compileAction(false)}>
        <HammerIcon style={{ width: 14, height: 14 }} /> {compiling ? 'Compiling…' : 'Compile'}
      </button>

      <div className="sep" />
      {simStatus === 'running' ? (
        <button className="icon-btn active" title="Pause simulation" onClick={() => simulationController.pause()}><PauseIcon /></button>
      ) : (
        <button className="icon-btn" title="Run (Ctrl+Enter) — compiles if needed, then executes firmware in the AVR emulator" disabled={compiling} onClick={runAction}>
          <PlayIcon style={{ color: '#3fb950' }} />
        </button>
      )}
      <button className="icon-btn" title="Step ~1 ms of CPU time" disabled={simStatus === 'stopped' || simStatus === 'error'} onClick={() => simulationController.step()}><StepIcon /></button>
      <button className="icon-btn" title="Reset the MCU (firmware restarts)" disabled={!simulationController.hasFirmware} onClick={() => simulationController.reset()}><ResetIcon /></button>
      <button className="icon-btn" title="Stop simulation" disabled={simStatus === 'stopped'} onClick={() => simulationController.stop()}><StopIcon /></button>

      <div style={{ flex: 1 }} />
      <button className="btn sm" onClick={() => setExportOpen(true)}>
        <ExportIcon style={{ width: 14, height: 14 }} /> Export
      </button>

      {exportOpen && <ExportModal onClose={() => setExportOpen(false)} />}
    </div>
  );
}

function ExportModal({ onClose }: { onClose: () => void }) {
  const project = useEditorStore((s) => s.project);
  if (!project) return null;
  const name = project.name.replace(/[^A-Za-z0-9_-]+/g, '_');
  const items: { label: string; desc: string; run: () => void }[] = [
    { label: 'CircuitDesk project (.cdproj.json)', desc: 'Full project — circuit, code, tests, custom parts. Re-importable.', run: () => exportProjectJson(project) },
    { label: 'ZIP project package', desc: 'Project JSON + code files + BOM + pin map + wiring/validation/test reports.', run: () => void exportProjectZip(project, testResultsCache) },
    { label: 'Bill of materials (BOM CSV)', desc: 'Part list with quantities and properties.', run: () => downloadFile(`${name}_bom.csv`, buildBomCsv(project), 'text/csv') },
    { label: 'Pin map (CSV)', desc: 'Every board pin with position, type, voltage and capabilities.', run: () => downloadFile(`${name}_pinmap.csv`, buildPinMapCsv(project), 'text/csv') },
    { label: 'Wiring report (TXT)', desc: 'Human-readable connection and net list.', run: () => downloadFile(`${name}_wiring.txt`, buildWiringReport(project), 'text/plain') },
    { label: 'Validation report (TXT)', desc: 'Current validation results with explanations.', run: () => downloadFile(`${name}_validation.txt`, buildValidationReport(project), 'text/plain') },
    { label: 'Board definition (JSON)', desc: 'The primary board definition with pin metadata.', run: () => exportBoardDefinition(project) },
    { label: 'Project image (SVG)', desc: 'Layout snapshot of the canvas.', run: () => exportProjectImage(project) },
  ];
  return (
    <Modal title={`Export — ${project.name}`} onClose={onClose} width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((item) => (
          <button
            key={item.label}
            className="btn"
            style={{ justifyContent: 'flex-start', flexDirection: 'column', alignItems: 'flex-start', padding: '9px 12px' }}
            onClick={() => {
              try {
                item.run();
                toast(`Exported: ${item.label}`, 'success');
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Export failed', 'error');
              }
            }}
          >
            <span style={{ fontWeight: 600 }}>{item.label}</span>
            <span style={{ color: 'var(--text-2)', fontSize: 11.5 }}>{item.desc}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
