import { useEffect, useRef, useState } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as MonacoNS from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { useEditorStore } from '../app/editorStore';
import { resolveDefinition } from '../project/partsRegistry';
import { boardsUsingSketch, sketchDocuments, sketchIdFor } from '../project/sketches';

// Bundle Monaco locally (no CDN) so CircuitDesk works fully offline.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco: MonacoNS });

type MonacoEditor = MonacoNS.editor.IStandaloneCodeEditor;
type Monaco = typeof MonacoNS;

let editorRef: MonacoEditor | null = null;
let monacoRef: Monaco | null = null;

/** Triggers Monaco layout — called when panels resize. */
export function layoutCodeEditor(): void {
  editorRef?.layout();
}

/** Jumps to a file/line/column and flashes a highlight (pin-aware navigation). */
export function revealCodeLocation(fileId: string, line: number, column: number, length: number): void {
  const s = useEditorStore.getState();
  s.setBottomTab('code');
  s.setActiveFile(fileId);
  setTimeout(() => {
    const editor = editorRef;
    const monaco = monacoRef;
    if (!editor || !monaco) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column });
    editor.focus();
    const decorations = editor.createDecorationsCollection([
      {
        range: new monaco.Range(line, column, line, column + length),
        options: { className: 'code-pin-highlight', inlineClassName: 'code-pin-highlight' },
      },
    ]);
    setTimeout(() => decorations.clear(), 2200);
  }, 60);
}

export function CodePanel() {
  const project = useEditorStore((s) => s.project);
  const activeFileId = useEditorStore((s) => s.activeFileId);
  const activeBoardId = useEditorStore((s) => s.activeBoardId);
  const lastCompile = useEditorStore((s) => s.lastCompile);
  const [addingFile, setAddingFile] = useState(false);
  const newFileRef = useRef<HTMLInputElement>(null);

  const file = project?.codeFiles.find((f) => f.id === activeFileId) ?? project?.codeFiles[0];

  // compiler diagnostics → editor markers
  useEffect(() => {
    const monaco = monacoRef;
    const editor = editorRef;
    if (!monaco || !editor || !file) return;
    const model = editor.getModel();
    if (!model) return;
    const markers = (lastCompile?.diagnostics ?? [])
      .filter((d) => d.file === file.name)
      .map((d) => ({
        severity:
          d.severity === 'error' ? monaco.MarkerSeverity.Error :
          d.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
        message: d.message,
        startLineNumber: Math.max(1, d.line),
        startColumn: Math.max(1, d.column),
        endLineNumber: Math.max(1, d.line),
        endColumn: Math.max(1, d.column) + 24,
      }));
    monaco.editor.setModelMarkers(model, 'circuitdesk-compiler', markers);
  }, [lastCompile, file, activeFileId]);

  if (!project || !file) return null;
  const s = useEditorStore.getState();

  const onMount: OnMount = (editor, monaco) => {
    editorRef = editor;
    monacoRef = monaco;
    monaco.editor.defineTheme('circuitdesk-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0d1117',
        'editorGutter.background': '#0d1117',
        'editorLineNumber.foreground': '#3a4756',
      },
    });
    monaco.editor.setTheme('circuitdesk-dark');
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <SketchAssignmentBar />
      <div className="code-tabs">
        {project.codeFiles.map((f) => (
          <div key={f.id} className={`code-tab ${f.id === file.id ? 'active' : ''}`}>
            <button onClick={() => s.setActiveFile(f.id)}>{f.name}</button>
            {project.codeFiles.length > 1 && f.name !== 'sketch.ino' && (
              <button
                className="close"
                title="Remove file"
                onClick={() => {
                  if (window.confirm(`Remove ${f.name} from the project?`)) s.removeCodeFile(f.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {addingFile ? (
          <input
            ref={newFileRef}
            autoFocus
            placeholder="newfile.h"
            style={{ margin: '3px 6px', width: 130 }}
            onBlur={() => setAddingFile(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const name = (e.target as HTMLInputElement).value.trim();
                if (/^[A-Za-z0-9_\-]{1,60}\.(ino|h|hpp|c|cpp)$/.test(name)) {
                  s.addCodeFile(name);
                  setAddingFile(false);
                }
              }
              if (e.key === 'Escape') setAddingFile(false);
            }}
          />
        ) : (
          <button className="icon-btn" title="Add a .h/.cpp file" onClick={() => setAddingFile(true)} style={{ margin: '2px 4px' }}>+</button>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          path={`${project.id}/${file.name}`}
          language="cpp"
          value={file.content}
          onChange={(value) => s.updateCodeFile(file.id, value ?? '')}
          onMount={onMount}
          options={{
            fontSize: 13,
            fontFamily: "'SF Mono', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            renderWhitespace: 'none',
            padding: { top: 8 },
          }}
          theme="vs-dark"
        />
      </div>
    </div>
  );
}

/**
 * Which board you are looking at, which sketch it runs, and who else runs it.
 *
 * The thing this has to prevent is a user editing what they think is one
 * board's code and silently changing another's. So when a sketch is shared it
 * says so, by name, before any typing happens — and "give this board its own
 * copy" is one button away rather than something you have to know to ask for.
 *
 * Hidden entirely when there is one board and one sketch, which is every
 * project that existed before this: nothing new to learn to blink an LED.
 */
function SketchAssignmentBar() {
  const project = useEditorStore((s) => s.project);
  const activeBoardId = useEditorStore((s) => s.activeBoardId);
  const activeFileId = useEditorStore((s) => s.activeFileId);
  const [renaming, setRenaming] = useState(false);
  if (!project) return null;

  const boards = project.boardInstances;
  const sketches = sketchDocuments(project);
  if (boards.length <= 1 && sketches.length <= 1) return null;

  const s = useEditorStore.getState();
  const boardName = (id: string) => {
    const inst = boards.find((b) => b.id === id);
    if (!inst) return id;
    if (inst.label) return inst.label;
    const def = resolveDefinition(inst.definitionId, project);
    const sameType = boards.filter((b) => b.definitionId === inst.definitionId);
    const n = sameType.findIndex((b) => b.id === id) + 1;
    return sameType.length > 1 ? `${def?.name ?? 'Board'} #${n}` : def?.name ?? 'Board';
  };

  const currentSketchId = activeBoardId ? sketchIdFor(project, activeBoardId) : activeFileId;
  const sketch = project.codeFiles.find((f) => f.id === currentSketchId);
  const sharing = currentSketchId ? boardsUsingSketch(project, currentSketchId) : [];

  return (
    <div className="sketch-bar">
      <label>
        Board
        <select
          value={activeBoardId ?? ''}
          onChange={(e) => s.setActiveBoard(e.target.value || null)}
          aria-label="Board being edited"
        >
          <option value="">— sketch —</option>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>{boardName(b.id)}</option>
          ))}
        </select>
      </label>

      <label>
        Sketch
        {renaming && sketch ? (
          <input
            autoFocus
            defaultValue={sketch.name}
            onBlur={(e) => { s.renameSketchDocument(sketch.id, e.target.value); setRenaming(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { s.renameSketchDocument(sketch.id, (e.target as HTMLInputElement).value); setRenaming(false); }
              if (e.key === 'Escape') setRenaming(false);
            }}
            style={{ width: 150 }}
          />
        ) : (
          <select
            value={currentSketchId ?? ''}
            onChange={(e) => {
              if (activeBoardId) s.assignSketchToBoard(activeBoardId, e.target.value);
              else s.setActiveFile(e.target.value);
            }}
            aria-label="Sketch assigned to this board"
          >
            {sketches.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        )}
      </label>

      {/* Named, not counted: "shared by 2 boards" still leaves the user
          wondering which two, and the answer decides whether they should be
          typing here at all. */}
      {sharing.length > 1 && (
        <span className="sketch-shared" title={sharing.map((b) => boardName(b.id)).join(', ')}>
          Shared by {sharing.map((b) => boardName(b.id)).join(', ')}
        </span>
      )}
      {sharing.length === 1 && activeBoardId && <span className="sketch-shared own">Only this board</span>}

      {sketch && !renaming && (
        <button className="btn sm" onClick={() => setRenaming(true)}>Rename</button>
      )}
      {activeBoardId && sharing.length > 1 && (
        <button
          className="btn sm"
          title="Give this board its own copy of the source. The other boards keep theirs unchanged."
          onClick={() => s.createSeparateSketchForBoard(activeBoardId)}
        >
          Create separate sketch
        </button>
      )}
    </div>
  );
}
