// Licenses and third-party notices, at the application level.
//
// This lives in the home experience rather than as a tab inside the editor.
// The editor is for the circuit, the code, the simulation and the project's own
// tools; a licence page competing for space there would be noise in the middle
// of someone's work, and it belongs to the application rather than to any one
// project.
//
// Everything shown comes from THIRD_PARTY_NOTICES.md. Nothing is retyped here,
// so the page cannot drift from the file the repository maintains.

import { useMemo, useState } from 'react';
import { navigate } from '../ui/primitives';
import { BackIcon, LogoIcon } from '../ui/icons';
import noticesMarkdown from '../../THIRD_PARTY_NOTICES.md?raw';
import { parseNotices, CATEGORY_LABELS, INDEPENDENCE_NOTICE, type NoticeEntry } from './noticesData';

/**
 * Renders one section's text.
 *
 * The markdown in the notices file is deliberately plain — paragraphs, bullets,
 * inline code and angle-bracketed links — so it is rendered directly rather
 * than by pulling in a markdown library for one page. Anything not recognised
 * is shown as the text it is, which keeps the legally required wording intact
 * even if someone writes a construct this does not style.
 */
function NoticeBody({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim().length > 0);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={i} className="notice-list">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ''))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="notice-text">
            {inline(block.replace(/\n/g, ' '))}
          </p>
        );
      })}
    </>
  );
}

/** Handles the inline forms the notices file actually uses. */
function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|<(https?:\/\/[^>\s]+)>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    if (match[1] !== undefined) out.push(<code key={key++}>{match[1]}</code>);
    else if (match[2] !== undefined) out.push(<strong key={key++}>{match[2]}</strong>);
    else if (match[3] !== undefined)
      out.push(
        <a key={key++} href={match[3]} target="_blank" rel="noreferrer noopener">
          {match[3]}
        </a>,
      );
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function NoticeCard({ entry }: { entry: NoticeEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`notice-card${entry.exclusion ? ' exclusion' : ''}`}>
      <button
        className="notice-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid={`notice-${entry.title}`}
      >
        <span className="notice-title">{entry.title}</span>
        <span className="notice-meta">
          {entry.license ? <span className="badge compile">{entry.license}</span> : null}
          {entry.exclusion ? <span className="badge">not distributed</span> : null}
        </span>
        <span className="notice-chevron">{open ? '−' : '+'}</span>
      </button>
      {entry.copyright || entry.url ? (
        <div className="notice-sub">
          {entry.copyright ? <span>{entry.copyright}</span> : null}
          {entry.url ? (
            <a href={entry.url} target="_blank" rel="noreferrer noopener">
              {entry.url}
            </a>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div className="notice-body">
          <NoticeBody text={entry.body} />
        </div>
      ) : null}
    </div>
  );
}

export function LicensesPage() {
  const { preamble, entries } = useMemo(() => parseNotices(noticesMarkdown), []);

  return (
    <div className="dashboard">
      <header className="dash-header">
        <button className="icon-btn" onClick={() => navigate('#/')} aria-label="Back to projects">
          <BackIcon />
        </button>
        <span className="dash-brand">
          <LogoIcon /> CircuitDesk <span className="tagline">Licenses &amp; third-party notices</span>
        </span>
      </header>

      <div className="dash-body">
        <div className="doc-page" data-testid="licenses-page">
          <h2 style={{ marginTop: 0 }}>Licenses &amp; third-party notices</h2>

          <div className="notice-independence">
            {INDEPENDENCE_NOTICE.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>

          {preamble ? (
            <div className="notice-preamble">
              <NoticeBody text={preamble} />
            </div>
          ) : null}

          {CATEGORY_LABELS.map(({ key, label, blurb }) => {
            const group = entries.filter((e) => e.category === key);
            if (group.length === 0) return null;
            return (
              <section key={key} className="notice-group">
                <h2>{label}</h2>
                <p className="notice-blurb">{blurb}</p>
                {group.map((entry) => (
                  <NoticeCard key={entry.title} entry={entry} />
                ))}
              </section>
            );
          })}

          <p className="notice-footnote">
            These notices are generated from the repository's own THIRD_PARTY_NOTICES file, so this page and that
            file cannot disagree. Every entry's full text is shown when expanded.
          </p>
        </div>
      </div>
    </div>
  );
}
