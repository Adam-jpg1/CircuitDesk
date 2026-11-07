// What other people built, and a way to share what you did.
//
// Every post is somebody else's data, so this page treats it that way: titles,
// names and descriptions are rendered as text, a card's picture is drawn from
// numbers through <img>, and "open a copy" goes through the same gate as an
// imported file. Nothing a post contains can become markup here.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { listProjectMetas, loadProject } from '../project/projectService';
import { renderPreviewSvg } from '../community/preview';
import { svgDataUrl } from '../canvas/thumbnail';
import {
  canDelete,
  CommunityError,
  deleteCommunityProject,
  getCommunityProject,
  listCommunity,
  openCopy,
  publishProject,
  rememberedCreatorKey,
  rememberedDisplayName,
  setLiked,
  type CommunityItem,
} from '../community/communityClient';
import { Modal, navigate, timeAgo, toast, useHashRoute } from '../ui/primitives';
import { CopyIcon, HeartIcon, SearchIcon, ShareIcon, StarIcon, UsersIcon } from '../ui/icons';
import { SiteHeader } from './SiteHeader';
import { architectureColour } from './TemplatesPage';
import type { ProjectMeta } from '../types';

function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function architectureOfBoardId(boardId: string): string {
  if (/pico|rp2040/.test(boardId)) return 'rp2040';
  if (/esp32/.test(boardId)) return 'esp32';
  if (/arduino/.test(boardId)) return 'avr';
  return 'other';
}

export function Author({ item }: { item: Pick<CommunityItem, 'authorName' | 'creator'> }) {
  const anon = item.authorName === 'Anonymous';
  return (
    <span className="cm-author">
      <span className={`cm-avatar${anon ? ' anon' : ''}`} style={{ ['--hue' as string]: hueOf(item.authorName) }} aria-hidden>
        {anon ? '?' : item.authorName.slice(0, 1).toUpperCase()}
      </span>
      {item.authorName}
      {item.creator && (
        <span className="creator-badge" title="Made by the creator of CircuitDesk">
          <StarIcon /> Creator
        </span>
      )}
    </span>
  );
}

function LikeButton({ item, onChange }: { item: CommunityItem; onChange: (next: CommunityItem) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={`like-btn${item.liked ? ' liked' : ''}`}
      aria-pressed={item.liked}
      aria-label={item.liked ? `Unlike (${item.likes} likes)` : `Like (${item.likes} likes)`}
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        // Shown at once, then corrected by what the server says.
        const optimistic = { ...item, liked: !item.liked, likes: item.likes + (item.liked ? -1 : 1) };
        onChange(optimistic);
        try {
          onChange(await setLiked(item.id, optimistic.liked));
        } catch (err) {
          onChange(item);
          toast(err instanceof Error ? err.message : 'Could not save the like.', 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      <HeartIcon filled={item.liked} />
      <span className="like-count">{item.likes}</span>
    </button>
  );
}

function CommunityCard({ item, onOpen, onChange }: { item: CommunityItem; onOpen: () => void; onChange: (i: CommunityItem) => void }) {
  const preview = useMemo(() => svgDataUrl(renderPreviewSvg(item.preview)), [item.preview]);
  return (
    <div
      className={`template-card tpl-card cm-card${item.creator ? ' creator' : ''}`}
      data-community-id={item.id}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      role="button"
      tabIndex={0}
      style={{ ['--arch' as string]: architectureColour(architectureOfBoardId(item.boardId)) }}
    >
      <div className="tpl-preview">
        <img alt={`${item.title} circuit`} src={preview} loading="lazy" />
        {item.creator && <span className="tpl-kind showcase">From the creator</span>}
      </div>
      <div className="tpl-body">
        <div className="t-board"><span className="dot" />{item.board || 'Unknown board'} · {item.partCount} parts</div>
        <div className="t-name">{item.title}</div>
        {item.description && <div className="t-desc">{item.description}</div>}
        {item.tags.length > 0 && <div className="cm-tags">{item.tags.map((t) => <span key={t} className="cm-tag">#{t}</span>)}</div>}
        <div className="cm-actions">
          <div style={{ display: 'grid', gap: 3 }}>
            <Author item={item} />
            <span className="cm-meta">{timeAgo(item.createdAt)}</span>
          </div>
          <LikeButton item={item} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}

type Sort = 'popular' | 'new';

export function CommunityPage() {
  const route = useHashRoute();
  const shareId = /[?&]share=([^&]+)/.exec(route)?.[1];
  const [items, setItems] = useState<CommunityItem[] | null>(null);
  const [creatorItems, setCreatorItems] = useState<CommunityItem[]>([]);
  const [creatorName, setCreatorName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('popular');
  const [query, setQuery] = useState('');
  const [board, setBoard] = useState('');
  const [open, setOpen] = useState<CommunityItem | null>(null);
  const [sharing, setSharing] = useState<string | null>(shareId ? decodeURIComponent(shareId) : null);
  // A link to "share this project" can arrive while the page is already open
  // (the hash changes, the page does not remount), so it is followed whenever
  // it changes, not only on the first render.
  useEffect(() => {
    if (shareId) setSharing(decodeURIComponent(shareId));
  }, [shareId]);

  const load = useCallback(async () => {
    try {
      const [all, creator] = await Promise.all([
        listCommunity({ sort, q: query.trim() || undefined, board: board || undefined }),
        listCommunity({ sort: 'popular', creatorOnly: true, limit: 6 }),
      ]);
      setItems(all.items);
      setCreatorItems(creator.items);
      setCreatorName(all.creatorName);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The community could not be loaded.');
      setItems([]);
    }
  }, [sort, query, board]);

  useEffect(() => {
    const t = setTimeout(() => void load(), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  const update = (next: CommunityItem) => {
    setItems((list) => list?.map((i) => (i.id === next.id ? next : i)) ?? list);
    setCreatorItems((list) => list.map((i) => (i.id === next.id ? next : i)));
    setOpen((o) => (o?.id === next.id ? next : o));
  };

  const boards = useMemo(() => {
    const seen = new Map<string, string>();
    for (const i of [...(items ?? []), ...creatorItems]) if (i.boardId) seen.set(i.boardId, i.board);
    return [...seen];
  }, [items, creatorItems]);
  const filtering = Boolean(query.trim() || board);
  const totalLikes = (items ?? []).reduce((n, i) => n + i.likes, 0);
  // The creator's row already shows their posts; the main grid is everyone else
  // unless the visitor is searching, when every match belongs in one list.
  const creatorIds = new Set(creatorItems.map((i) => i.id));
  const listed = filtering ? items ?? [] : (items ?? []).filter((i) => !creatorIds.has(i.id));

  return (
    <div className="dashboard">
      <SiteHeader
        active="community"
        actions={
          <button className="btn primary" onClick={() => setSharing('')}>
            <ShareIcon style={{ width: 14, height: 14 }} /> Share a project
          </button>
        }
      />
      <div className="dash-body site-page">
        <section className="site-hero" style={{ gridTemplateColumns: '1fr' }}>
          <div className="site-hero-text">
            <h1>Community</h1>
            <p>
              Circuits people built and shared. Like the ones you enjoy, and open a copy of anything to run and change
              it. The original stays as it was.
            </p>
            {items && !error && (
              <div className="site-stats">
                <span><b>{items.length}</b> projects</span>
                <span><b>{new Set(items.map((i) => i.boardId)).size}</b> boards</span>
                <span><b>{totalLikes}</b> likes</span>
              </div>
            )}
          </div>
        </section>

        {error ? (
          <div className="cm-unavailable">
            <UsersIcon style={{ width: 40, height: 40, opacity: 0.6 }} />
            <h3 style={{ color: 'var(--text-0)' }}>The community is not reachable right now</h3>
            <p>{error} Your own projects and the templates still work.</p>
            <button className="btn" onClick={() => void load()}>Try again</button>
          </div>
        ) : (
          <>
            {creatorItems.length > 0 && !filtering && (
              <>
                <div className="dash-section-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <StarIcon style={{ width: 13, height: 13, color: '#fcc419' }} /> From the creator{creatorName ? ` · ${creatorName}` : ''}
                </div>
                <div className="cm-creator-row">
                  {creatorItems.map((i) => <CommunityCard key={i.id} item={i} onOpen={() => setOpen(i)} onChange={update} />)}
                </div>
              </>
            )}

            <div className="site-filters">
              <div className="segmented" role="tablist" aria-label="Sort">
                {(['popular', 'new'] as const).map((s) => (
                  <button key={s} role="tab" aria-selected={sort === s} className={sort === s ? 'active' : ''} onClick={() => setSort(s)}>
                    {s === 'popular' ? 'Most liked' : 'Newest'}
                  </button>
                ))}
              </div>
              <div className="chip-row" aria-label="Board">
                <button className={`chip${board === '' ? ' active' : ''}`} onClick={() => setBoard('')}>Every board</button>
                {boards.map(([id, name]) => (
                  <button
                    key={id}
                    className={`chip${board === id ? ' active' : ''}`}
                    style={{ ['--arch' as string]: architectureColour(architectureOfBoardId(id)) }}
                    onClick={() => setBoard(board === id ? '' : id)}
                  >
                    <span className="dot" /> {name}
                  </button>
                ))}
              </div>
              <label className="site-search">
                <SearchIcon />
                <input type="search" placeholder="Search projects, makers, tags…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
            </div>

            <div className="dash-section-title">{filtering ? 'Results' : 'From the community'}</div>
            {items === null ? (
              <div className="empty-state"><div className="spinner" /> Loading the community…</div>
            ) : (
              <div className="tpl-grid">
                {listed.map((i) => <CommunityCard key={i.id} item={i} onOpen={() => setOpen(i)} onChange={update} />)}
                {listed.length === 0 && <div className="empty-state">Nothing matches yet. Be the first to share one.</div>}
              </div>
            )}
          </>
        )}
      </div>

      {open && <DetailModal item={open} onClose={() => setOpen(null)} onChange={update} onDeleted={() => { setOpen(null); void load(); }} />}
      {sharing !== null && (
        <ShareModal
          initialProjectId={sharing}
          onClose={() => {
            setSharing(null);
            if (shareId) navigate('#/community');
          }}
          onShared={(item) => {
            setSharing(null);
            if (shareId) navigate('#/community');
            void load();
            setOpen(item);
          }}
        />
      )}
    </div>
  );
}

function DetailModal({
  item,
  onClose,
  onChange,
  onDeleted,
}: {
  item: CommunityItem;
  onClose: () => void;
  onChange: (i: CommunityItem) => void;
  onDeleted: () => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    let live = true;
    getCommunityProject(item.id)
      .then(({ project }) => {
        const files = (project as { codeFiles?: { content?: unknown }[] }).codeFiles ?? [];
        const text = typeof files[0]?.content === 'string' ? files[0].content : '';
        if (live) setCode(text.split('\n').slice(0, 60).join('\n'));
      })
      .catch(() => live && setCode(''));
    return () => {
      live = false;
    };
  }, [item.id]);
  const preview = useMemo(() => svgDataUrl(renderPreviewSvg(item.preview)), [item.preview]);

  return (
    <Modal
      title={item.title}
      onClose={onClose}
      width={720}
      footer={
        <>
          {canDelete(item.id) && (
            <button
              className="btn danger"
              style={{ marginRight: 'auto' }}
              onClick={async () => {
                try {
                  await deleteCommunityProject(item.id);
                  toast(`Removed “${item.title}” from the community`, 'success');
                  onDeleted();
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Could not remove it.', 'error');
                }
              }}
            >
              Remove my post
            </button>
          )}
          <LikeButton item={item} onChange={onChange} />
          <button
            className="btn primary"
            disabled={opening}
            onClick={async () => {
              setOpening(true);
              try {
                const copy = await openCopy(item.id);
                toast(`Opened a copy of “${item.title}”`, 'success');
                navigate(`#/editor/${copy.id}`);
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Could not open a copy.', 'error');
                setOpening(false);
              }
            }}
          >
            <CopyIcon style={{ width: 14, height: 14 }} /> {opening ? 'Opening…' : 'Open a copy'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <img className="cm-detail-preview" alt={`${item.title} circuit`} src={preview} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Author item={item} />
          <span className="cm-meta">{item.board} · {item.partCount} parts · {timeAgo(item.createdAt)}</span>
        </div>
        {item.description && <p style={{ margin: 0, lineHeight: 1.6, color: 'var(--text-1)', whiteSpace: 'pre-wrap' }}>{item.description}</p>}
        {item.tags.length > 0 && <div className="cm-tags">{item.tags.map((t) => <span key={t} className="cm-tag">#{t}</span>)}</div>}
        <div className="dash-section-title" style={{ margin: '4px 0 0' }}>Sketch</div>
        <pre className="cm-code">{code === null ? 'Loading…' : code || '(no code)'}</pre>
      </div>
    </Modal>
  );
}

function ShareModal({
  initialProjectId,
  onClose,
  onShared,
}: {
  initialProjectId: string;
  onClose: () => void;
  onShared: (item: CommunityItem) => void;
}) {
  const [metas, setMetas] = useState<ProjectMeta[] | null>(null);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [name, setName] = useState(rememberedDisplayName());
  const [tags, setTags] = useState('');
  const [creatorKey, setCreatorKey] = useState(rememberedCreatorKey());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void listProjectMetas()
      .then((m) => {
        setMetas(m);
        const chosen = m.find((x) => x.id === initialProjectId) ?? m[0];
        if (chosen) {
          setProjectId(chosen.id);
          setTitle(chosen.name);
        }
      })
      .catch(() => setMetas([]));
  }, [initialProjectId]);

  const submit = async () => {
    setProblem(null);
    const project = projectId ? await loadProject(projectId) : null;
    if (!project) return setProblem('Choose one of your projects to share.');
    setBusy(true);
    try {
      const item = await publishProject({
        project,
        title: title.trim(),
        description: description.trim(),
        authorName: name.trim(),
        tags: tags.split(/[,\s]+/).map((t) => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean),
        creatorKey,
      });
      if (creatorKey.trim() && !item.creator) {
        toast('Shared, but the creator key was not accepted, so it is posted without the Creator badge.', 'error');
      } else {
        toast(`Shared “${item.title}” with the community`, 'success');
      }
      onShared(item);
    } catch (err) {
      setProblem(err instanceof CommunityError || err instanceof Error ? err.message : 'Could not share it.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Share a project"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !metas?.length} onClick={() => void submit()}>
            <ShareIcon style={{ width: 14, height: 14 }} /> {busy ? 'Sharing…' : 'Share'}
          </button>
        </>
      }
    >
      {metas === null ? (
        <div className="empty-state"><div className="spinner" /> Loading your projects…</div>
      ) : metas.length === 0 ? (
        <p>You have no projects yet. Make one, or start from a template, and share it from here.</p>
      ) : (
        <div className="cm-form">
          <label>
            Project
            <select
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setTitle(metas.find((m) => m.id === e.target.value)?.name ?? '');
              }}
            >
              {metas.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.primaryBoard})</option>)}
            </select>
          </label>
          <label>
            Title
            <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            What does it do?
            <textarea value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} placeholder="What it does, what to try, what you learned." />
          </label>
          <label>
            Display name <span className="cm-hint">(leave empty to post as Anonymous)</span>
            <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Anonymous" />
          </label>
          <label>
            Tags <span className="cm-hint">(up to 5, separated by commas)</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="sensors, beginner" />
          </label>
          <details>
            <summary className="cm-hint" style={{ cursor: 'pointer' }}>I am the site creator</summary>
            <label style={{ marginTop: 8 }}>
              Creator key <span className="cm-hint">(the server's CREATOR_TOKEN; kept in this browser only)</span>
              <input type="password" value={creatorKey} onChange={(e) => setCreatorKey(e.target.value)} autoComplete="off" />
            </label>
          </details>
          <div className="cm-hint">
            Your circuit and code are published as they are now. Anyone can open a copy; nobody can change yours. Only
            this browser can remove it again.
          </div>
          {problem && <div style={{ color: 'var(--error, #f85149)', fontSize: 12.5 }}>{problem}</div>}
        </div>
      )}
    </Modal>
  );
}
