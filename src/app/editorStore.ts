import { create } from 'zustand';
import {
  uid,
  type CircuitProject,
  type CodeFile,
  type ComponentInstance,
  type Connection,
  type CompileResult,
  type TestCase,
  type ValidationIssue,
} from '../types';
import { loadProject, saveProject } from '../project/projectService';
import { resolveDefinition } from '../project/partsRegistry';
import { assignSketch, createSeparateSketch, renameSketch, sketchIdFor } from '../project/sketches';
import { loadSetting, saveSetting, DEFAULT_PANEL_SIZES, type PanelSizes } from '../persistence/settings';
import { renderProjectThumbnail } from '../canvas/thumbnail';

export type Tool = 'select' | 'wire' | 'pan';
export type BottomTab = 'code' | 'serial' | 'compiler' | 'validation' | 'tests' | 'pins' | 'debug';

interface CircuitSnapshot {
  boardInstances: ComponentInstance[];
  componentInstances: ComponentInstance[];
  connections: Connection[];
}

export interface Selection {
  componentIds: string[];
  connectionIds: string[];
}

export interface WireDraft {
  fromComponentId: string;
  fromPinId: string;
  points: number[];
  cursor: { x: number; y: number } | null;
}

interface EditorState {
  project: CircuitProject | null;
  loading: boolean;
  loadError: string | null;
  saveState: 'saved' | 'saving' | 'unsaved';

  tool: Tool;
  selection: Selection;
  wireDraft: WireDraft | null;
  view: { x: number; y: number; zoom: number };
  hoveredPin: { componentId: string; pinId: string } | null;
  /**
   * The keypad or keyboard whose full-size key panel is open, or null.
   *
   * A view of one part, not a mode: the panel presses the same contacts the
   * canvas does, so nothing about the circuit depends on whether it is open.
   */
  keyPanelInstanceId: string | null;
  bottomTab: BottomTab;
  activeFileId: string | null;
  /**
   * The board whose sketch the editor is showing, or null for the sketch view.
   *
   * The editor edits a *document*; this is only which board's document it has
   * open, so switching boards never copies or moves anything. Null means the
   * user picked a sketch directly rather than through a board.
   */
  activeBoardId: string | null;
  panelSizes: PanelSizes;

  compiling: boolean;
  lastCompile: CompileResult | null;
  validationIssues: ValidationIssue[];
  highlightedIssueId: string | null;

  undoDepth: number;
  redoDepth: number;

  // actions
  load(id: string): Promise<void>;
  closeProject(): void;
  markDirtyAndSave(): void;

  setTool(tool: Tool): void;
  setView(view: { x: number; y: number; zoom: number }): void;
  setSelection(sel: Selection): void;
  setHoveredPin(pin: { componentId: string; pinId: string } | null): void;
  setKeyPanel(instanceId: string | null): void;
  setBottomTab(tab: BottomTab): void;
  setActiveFile(id: string): void;
  /** Opens the sketch a board runs. Does not copy or reassign anything. */
  setActiveBoard(boardInstanceId: string | null): void;
  /** Points a board at an existing sketch document. */
  assignSketchToBoard(boardInstanceId: string, sketchId: string): void;
  /** Clones what a board is running into a sketch only it uses. */
  createSeparateSketchForBoard(boardInstanceId: string): void;
  /** Renames a sketch. Assignments are by id, so nothing else moves. */
  renameSketchDocument(sketchId: string, name: string): void;
  setPanelSizes(sizes: Partial<PanelSizes>): void;
  setWireDraft(draft: WireDraft | null): void;
  setCompiling(v: boolean): void;
  setLastCompile(r: CompileResult | null): void;
  setValidationIssues(issues: ValidationIssue[]): void;
  setHighlightedIssue(id: string | null): void;

  renameProject(name: string): void;
  mutateCircuit(fn: (p: CircuitProject) => void, options?: { undoable?: boolean }): void;
  addInstance(definitionId: string, x: number, y: number): string | null;
  moveInstances(ids: string[], dx: number, dy: number, final: boolean): void;
  rotateSelection(): void;
  deleteSelection(): void;
  addConnection(conn: Omit<Connection, 'id' | 'netId'>): void;
  updateConnection(id: string, patch: Partial<Connection>): void;
  setInstanceProperty(instanceId: string, key: string, value: unknown): void;
  setInstanceLabel(instanceId: string, label: string): void;
  copySelection(): void;
  pasteClipboard(): void;

  updateCodeFile(fileId: string, content: string): void;
  addCodeFile(name: string): void;
  removeCodeFile(fileId: string): void;

  addTest(test: TestCase): void;
  updateTest(test: TestCase): void;
  removeTest(testId: string): void;
  setAssemblyNotes(notes: string): void;

  undo(): void;
  redo(): void;
}

const MAX_UNDO = 60;

let undoStack: CircuitSnapshot[] = [];
let redoStack: CircuitSnapshot[] = [];
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let moveSnapshotTaken = false;
let clipboard: { instances: ComponentInstance[]; connections: Connection[] } | null = null;

function snapshotOf(p: CircuitProject): CircuitSnapshot {
  return structuredClone({
    boardInstances: p.boardInstances,
    componentInstances: p.componentInstances,
    connections: p.connections,
  });
}

export const useEditorStore = create<EditorState>((set, get) => {
  function scheduleSave(): void {
    set({ saveState: 'unsaved' });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const { project } = get();
      if (!project) return;
      set({ saveState: 'saving' });
      try {
        project.updatedAt = new Date().toISOString();
        try {
          project.thumbnailSvg = renderProjectThumbnail(project);
        } catch {
          // thumbnail is cosmetic
        }
        await saveProject(project);
        set({ saveState: 'saved' });
      } catch (err) {
        console.error('[CircuitDesk] autosave failed:', err);
        set({ saveState: 'unsaved' });
      }
    }, 700);
  }

  function pushUndo(): void {
    const { project } = get();
    if (!project) return;
    undoStack.push(snapshotOf(project));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
    set({ undoDepth: undoStack.length, redoDepth: 0 });
  }

  return {
    project: null,
    loading: false,
    loadError: null,
    saveState: 'saved',
    tool: 'select',
    selection: { componentIds: [], connectionIds: [] },
    wireDraft: null,
    view: { x: 0, y: 0, zoom: 1 },
    hoveredPin: null,
    keyPanelInstanceId: null,
    bottomTab: 'code',
    activeFileId: null,
    activeBoardId: null,
    panelSizes: loadSetting('panelSizes', DEFAULT_PANEL_SIZES),
    compiling: false,
    lastCompile: null,
    validationIssues: [],
    highlightedIssueId: null,
    undoDepth: 0,
    redoDepth: 0,

    async load(id) {
      const current = get();
      if (current.loading || current.project?.id === id) return;
      set({ loading: true, loadError: null, project: null, lastCompile: null, validationIssues: [] });
      undoStack = [];
      redoStack = [];
      try {
        const project = await loadProject(id);
        if (!project) {
          set({ loading: false, loadError: 'Project not found. It may have been deleted.' });
          return;
        }
        saveSetting('recentProjectId', id);
        set({
          loading: false,
          project,
          activeFileId: project.codeFiles[0]?.id ?? null,
          activeBoardId: null,
          selection: { componentIds: [], connectionIds: [] },
          keyPanelInstanceId: null,
          saveState: 'saved',
          undoDepth: 0,
          redoDepth: 0,
          view: { x: 0, y: 0, zoom: 1 },
        });
      } catch (err) {
        console.error('[CircuitDesk] project load failed:', err);
        set({
          loading: false,
          loadError: err instanceof Error ? err.message : 'Failed to load project.',
        });
      }
    },

    closeProject() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      const { project } = get();
      if (project) {
        project.updatedAt = new Date().toISOString();
        void saveProject(project).catch(() => undefined);
      }
      undoStack = [];
      redoStack = [];
      set({ project: null, loadError: null, lastCompile: null, validationIssues: [], wireDraft: null, keyPanelInstanceId: null });
    },

    markDirtyAndSave: scheduleSave,

    setTool: (tool) => set({ tool, wireDraft: null }),
    setView: (view) => set({ view }),
    setSelection: (selection) => set({ selection }),
    setHoveredPin: (hoveredPin) => set({ hoveredPin }),
    setKeyPanel: (keyPanelInstanceId) => set({ keyPanelInstanceId }),
    setBottomTab: (bottomTab) => set({ bottomTab }),
    setActiveFile: (activeFileId) => set({ activeFileId, activeBoardId: null }),

    setActiveBoard(boardInstanceId) {
      const { project } = get();
      if (!project || !boardInstanceId) {
        set({ activeBoardId: null });
        return;
      }
      set({ activeBoardId: boardInstanceId, activeFileId: sketchIdFor(project, boardInstanceId) ?? null });
    },

    assignSketchToBoard(boardInstanceId, sketchId) {
      const { project } = get();
      if (!project) return;
      const next = assignSketch(project, boardInstanceId, sketchId);
      if (next === project) return;
      set({ project: next, activeBoardId: boardInstanceId, activeFileId: sketchId });
      scheduleSave();
    },

    createSeparateSketchForBoard(boardInstanceId) {
      const { project } = get();
      if (!project) return;
      const { project: next, sketchId } = createSeparateSketch(project, boardInstanceId);
      set({ project: next, activeBoardId: boardInstanceId, activeFileId: sketchId });
      scheduleSave();
    },

    renameSketchDocument(sketchId, name) {
      const { project } = get();
      if (!project) return;
      const next = renameSketch(project, sketchId, name);
      if (next === project) return;
      set({ project: next });
      scheduleSave();
    },
    setPanelSizes(sizes) {
      const next = { ...get().panelSizes, ...sizes };
      saveSetting('panelSizes', next);
      set({ panelSizes: next });
    },
    setWireDraft: (wireDraft) => set({ wireDraft }),
    setCompiling: (compiling) => set({ compiling }),
    setLastCompile: (lastCompile) => set({ lastCompile }),
    setValidationIssues: (validationIssues) => set({ validationIssues }),
    setHighlightedIssue: (highlightedIssueId) => set({ highlightedIssueId }),

    renameProject(name) {
      const { project } = get();
      if (!project || !name.trim()) return;
      set({ project: { ...project, name: name.trim() } });
      scheduleSave();
    },

    mutateCircuit(fn, options = {}) {
      const { project } = get();
      if (!project) return;
      if (options.undoable !== false) pushUndo();
      const next = { ...project };
      fn(next);
      next.boardInstances = [...next.boardInstances];
      next.componentInstances = [...next.componentInstances];
      next.connections = [...next.connections];
      set({ project: next });
      scheduleSave();
    },

    addInstance(definitionId, x, y) {
      const { project } = get();
      if (!project) return null;
      const def = resolveDefinition(definitionId, project);
      if (!def) return null;
      const inst: ComponentInstance = {
        id: uid('inst'),
        definitionId,
        x: Math.round(x),
        y: Math.round(y),
        rotation: 0,
        properties: Object.fromEntries((def.isBoard ? [] : def.properties).map((p) => [p.key, p.default])),
        simulationState: {},
      };
      get().mutateCircuit((p) => {
        if (def.isBoard) p.boardInstances.push(inst);
        else p.componentInstances.push(inst);
      });
      set({ selection: { componentIds: [inst.id], connectionIds: [] } });
      return inst.id;
    },

    moveInstances(ids, dx, dy, final) {
      const { project } = get();
      if (!project || ids.length === 0) return;
      if (!moveSnapshotTaken) {
        pushUndo();
        moveSnapshotTaken = true;
      }
      const move = (arr: ComponentInstance[]) =>
        arr.map((i) => (ids.includes(i.id) ? { ...i, x: i.x + dx, y: i.y + dy } : i));
      set({
        project: {
          ...project,
          boardInstances: move(project.boardInstances),
          componentInstances: move(project.componentInstances),
        },
      });
      if (final) {
        moveSnapshotTaken = false;
        scheduleSave();
      }
    },

    rotateSelection() {
      const ids = get().selection.componentIds;
      if (ids.length === 0) return;
      get().mutateCircuit((p) => {
        const rot = (arr: ComponentInstance[]) =>
          arr.forEach((i, idx) => {
            if (ids.includes(i.id)) arr[idx] = { ...i, rotation: (i.rotation + 90) % 360 };
          });
        rot(p.boardInstances);
        rot(p.componentInstances);
      });
    },

    deleteSelection() {
      const { selection, project } = get();
      if (!project) return;
      if (selection.componentIds.length === 0 && selection.connectionIds.length === 0) return;
      get().mutateCircuit((p) => {
        const gone = new Set(selection.componentIds);
        p.boardInstances = p.boardInstances.filter((i) => !gone.has(i.id));
        p.componentInstances = p.componentInstances.filter((i) => !gone.has(i.id));
        p.connections = p.connections.filter(
          (c) =>
            !selection.connectionIds.includes(c.id) &&
            !gone.has(c.sourceComponentId) &&
            !gone.has(c.targetComponentId),
        );
      });
      set({ selection: { componentIds: [], connectionIds: [] } });
    },

    addConnection(conn) {
      get().mutateCircuit((p) => {
        p.connections.push({ ...conn, id: uid('wire'), netId: '' });
      });
    },

    updateConnection(id, patch) {
      get().mutateCircuit((p) => {
        p.connections = p.connections.map((c) => (c.id === id ? { ...c, ...patch } : c));
      });
    },

    setInstanceProperty(instanceId, key, value) {
      get().mutateCircuit((p) => {
        const patch = (arr: ComponentInstance[]) =>
          arr.forEach((i, idx) => {
            if (i.id === instanceId) arr[idx] = { ...i, properties: { ...i.properties, [key]: value } };
          });
        patch(p.boardInstances);
        patch(p.componentInstances);
      });
    },

    setInstanceLabel(instanceId, label) {
      get().mutateCircuit((p) => {
        const patch = (arr: ComponentInstance[]) =>
          arr.forEach((i, idx) => {
            if (i.id === instanceId) arr[idx] = { ...i, label };
          });
        patch(p.boardInstances);
        patch(p.componentInstances);
      });
    },

    copySelection() {
      const { project, selection } = get();
      if (!project || selection.componentIds.length === 0) return;
      const ids = new Set(selection.componentIds);
      const instances = [...project.boardInstances, ...project.componentInstances].filter((i) => ids.has(i.id));
      const connections = project.connections.filter(
        (c) => ids.has(c.sourceComponentId) && ids.has(c.targetComponentId),
      );
      clipboard = structuredClone({ instances, connections });
    },

    pasteClipboard() {
      const { project } = get();
      if (!project || !clipboard) return;
      const idMap = new Map<string, string>();
      const newInstances = clipboard.instances.map((i) => {
        const nid = uid('inst');
        idMap.set(i.id, nid);
        return { ...structuredClone(i), id: nid, x: i.x + 40, y: i.y + 40 };
      });
      const newConnections = clipboard.connections.map((c) => ({
        ...structuredClone(c),
        id: uid('wire'),
        sourceComponentId: idMap.get(c.sourceComponentId)!,
        targetComponentId: idMap.get(c.targetComponentId)!,
      }));
      get().mutateCircuit((p) => {
        for (const inst of newInstances) {
          const def = resolveDefinition(inst.definitionId, p);
          if (def?.isBoard) p.boardInstances.push(inst);
          else p.componentInstances.push(inst);
        }
        p.connections.push(...newConnections);
      });
      set({ selection: { componentIds: newInstances.map((i) => i.id), connectionIds: [] } });
    },

    updateCodeFile(fileId, content) {
      const { project } = get();
      if (!project) return;
      set({
        project: {
          ...project,
          codeFiles: project.codeFiles.map((f) => (f.id === fileId ? { ...f, content } : f)),
        },
      });
      scheduleSave();
    },

    addCodeFile(name) {
      const { project } = get();
      if (!project) return;
      const file: CodeFile = { id: uid('file'), name, content: '', language: 'cpp' };
      set({
        project: { ...project, codeFiles: [...project.codeFiles, file] },
        activeFileId: file.id,
      });
      scheduleSave();
    },

    removeCodeFile(fileId) {
      const { project, activeFileId } = get();
      if (!project || project.codeFiles.length <= 1) return;
      const files = project.codeFiles.filter((f) => f.id !== fileId);
      set({
        project: { ...project, codeFiles: files },
        activeFileId: activeFileId === fileId ? files[0]?.id ?? null : activeFileId,
      });
      scheduleSave();
    },

    addTest(test) {
      const { project } = get();
      if (!project) return;
      set({ project: { ...project, tests: [...project.tests, test] } });
      scheduleSave();
    },

    updateTest(test) {
      const { project } = get();
      if (!project) return;
      set({ project: { ...project, tests: project.tests.map((t) => (t.id === test.id ? test : t)) } });
      scheduleSave();
    },

    removeTest(testId) {
      const { project } = get();
      if (!project) return;
      set({ project: { ...project, tests: project.tests.filter((t) => t.id !== testId) } });
      scheduleSave();
    },

    setAssemblyNotes(notes) {
      const { project } = get();
      if (!project) return;
      set({ project: { ...project, settings: { ...project.settings, assemblyNotes: notes } } });
      scheduleSave();
    },

    undo() {
      const { project } = get();
      if (!project || undoStack.length === 0) return;
      const snap = undoStack.pop()!;
      redoStack.push(snapshotOf(project));
      set({
        project: { ...project, ...structuredClone(snap) },
        undoDepth: undoStack.length,
        redoDepth: redoStack.length,
        selection: { componentIds: [], connectionIds: [] },
      });
      scheduleSave();
    },

    redo() {
      const { project } = get();
      if (!project || redoStack.length === 0) return;
      const snap = redoStack.pop()!;
      undoStack.push(snapshotOf(project));
      set({
        project: { ...project, ...structuredClone(snap) },
        undoDepth: undoStack.length,
        redoDepth: redoStack.length,
        selection: { componentIds: [], connectionIds: [] },
      });
      scheduleSave();
    },
  };
});
