import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { SUPPORT_LEVEL_LABEL, type SupportLevel } from '../types';

// ---------- support badge ----------

export function SupportBadge({ level, title }: { level: SupportLevel; title?: string }) {
  return (
    <span className={`badge ${level}`} title={title ?? supportBadgeTitle(level)}>
      {SUPPORT_LEVEL_LABEL[level]}
    </span>
  );
}

function supportBadgeTitle(level: SupportLevel): string {
  switch (level) {
    case 'simulated':
      return 'Full firmware simulation: compiled code executes on a real emulator and drives this part.';
    case 'compile':
      return 'Code compiles for this target; canvas simulation is limited or unavailable.';
    case 'validation':
      return 'Wiring and electrical validation rules are checked. Not simulated.';
    case 'wiring':
      return 'Can be placed and wired with real pins and metadata. Not validated in depth, not simulated.';
    case 'visual-only':
      return 'Visual reference only.';
  }
}

// ---------- modal ----------

export function Modal({
  title,
  onClose,
  children,
  footer,
  width,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width } : undefined}>
        <div className="modal-header">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- context menu ----------

export interface MenuEntry {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function ContextMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: (MenuEntry | 'sep')[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - entries.length * 30 - 20),
  };
  return (
    <div ref={ref} className="context-menu" style={style}>
      {entries.map((e, i) =>
        e === 'sep' ? (
          <div key={i} className="cm-sep" />
        ) : (
          <button
            key={i}
            className={e.danger ? 'danger' : ''}
            disabled={e.disabled}
            onClick={() => {
              onClose();
              e.onClick();
            }}
          >
            {e.label}
          </button>
        ),
      )}
    </div>
  );
}

// ---------- toasts ----------

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

interface ToastState {
  toasts: Toast[];
  push(text: string, kind?: Toast['kind']): void;
  remove(id: number): void;
}

let toastId = 0;
export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push(text, kind = 'info') {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200);
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = (text: string, kind: Toast['kind'] = 'info') => useToastStore.getState().push(text, kind);

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
      ))}
    </div>
  );
}

// ---------- error boundary ----------

export class ErrorBoundary extends Component<
  { name: string; children: ReactNode; onRecover?: () => void },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h3>Something went wrong in the {this.props.name}</h3>
          <p>The rest of CircuitDesk is still running. Your project data is saved locally.</p>
          <pre>{String(this.state.error.stack ?? this.state.error.message)}</pre>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn primary"
              onClick={() => {
                this.setState({ error: null });
                this.props.onRecover?.();
              }}
            >
              Try again
            </button>
            <button
              className="btn"
              onClick={() => {
                this.setState({ error: null });
                window.location.hash = '#/';
              }}
            >
              Back to dashboard
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------- resize handle ----------

export function ResizeHandle({
  direction,
  onDelta,
  onDone,
}: {
  direction: 'vertical' | 'horizontal';
  onDelta: (delta: number) => void;
  onDone?: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`resize-handle ${direction} ${dragging ? 'dragging' : ''}`}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setDragging(true);
        let last = direction === 'vertical' ? e.clientX : e.clientY;
        const move = (ev: PointerEvent) => {
          const cur = direction === 'vertical' ? ev.clientX : ev.clientY;
          if (Math.abs(cur - last) >= 1) {
            onDelta(cur - last);
            last = cur;
          }
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          setDragging(false);
          onDone?.();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

// ---------- hash router ----------

export function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export function navigate(to: string): void {
  window.location.hash = to;
}

// ---------- misc ----------

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function downloadFile(name: string, content: string | Blob, mime = 'application/octet-stream'): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
