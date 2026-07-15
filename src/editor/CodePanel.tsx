import { useEffect, useRef, useState } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as MonacoNS from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { useEditorStore } from '../app/editorStore';

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
