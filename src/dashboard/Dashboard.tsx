import { useCallback, useEffect, useRef, useState } from 'react';
import { listProjectMetas, saveProject, deleteProject, duplicateProject, loadProject } from '../project/projectService';
import { buildBlinkProject, emptyProject } from '../project/templates';
import { navigate, ContextMenu, Modal, SupportBadge, timeAgo, toast } from '../ui/primitives';
import { LogoIcon, ImportIcon, PlusIcon, ChipIcon, LayersIcon } from '../ui/icons';
import { SiteHeader } from '../site/SiteHeader';
import { loadSetting } from '../persistence/settings';
import { svgDataUrl } from '../canvas/thumbnail';
import type { CircuitProject, ProjectMeta } from '../types';

type SortKey = 'updated' | 'name' | 'created';

export function Dashboard() {
  const [metas, setMetas] = useState<ProjectMeta[] | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  const [menu, setMenu] = useState<{ x: number; y: number; meta: ProjectMeta } | null>(null);
  const [renaming, setRenaming] = useState<ProjectMeta | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProjectMeta | null>(null);
  const creatingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setMetas(await listProjectMetas());
    } catch (err) {
      console.error('[CircuitDesk] failed to list projects:', err);
      toast('Could not load your projects from local storage. See the browser console for details.', 'error');
      setMetas([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Guarded creation: one click creates exactly one project.
  const createProject = useCallback(
    async (build: () => CircuitProject) => {
      if (creatingRef.current) return;
      creatingRef.current = true;
      try {
        const project = build();
        await saveProject(project);
        navigate(`#/editor/${project.id}`);
      } catch (err) {
        console.error('[CircuitDesk] project creation failed:', err);
        toast('Could not create the project. See the browser console for details.', 'error');
      } finally {
        creatingRef.current = false;
      }
    },
    [],
  );

  const recentId = loadSetting<string | null>('recentProjectId', null);
  const filtered = (metas ?? [])
    .filter((m) => m.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'created') return a.createdAt < b.createdAt ? 1 : -1;
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
  const recent = metas?.find((m) => m.id === recentId);

  return (
    <div className="dashboard">
      <SiteHeader
        active="projects"
        actions={
          <>
            <button className="btn" onClick={() => navigate('#/custom-parts')}>
              <ChipIcon style={{ width: 14, height: 14 }} /> Custom boards
            </button>
            <button className="btn" onClick={() => navigate('#/import')}>
              <ImportIcon style={{ width: 14, height: 14 }} /> Import
            </button>
            <button className="btn" onClick={() => navigate('#/licenses')}>Licenses</button>
            <button className="btn" onClick={() => navigate('#/about')}>About</button>
            {/* A new project is blank. Starting the user inside a wired Blink
                means their first act is deleting someone else's circuit; the
                templates are where a worked example belongs. */}
            <button className="btn primary" onClick={() => void createProject(() => emptyProject('Untitled Project'))}>
              <PlusIcon style={{ width: 14, height: 14 }} /> New project
            </button>
          </>
        }
      />

      <div className="dash-body">
        {metas === null ? (
          <div className="empty-state"><div className="spinner" /> Loading projects…</div>
        ) : metas.length === 0 ? (
          <div className="empty-state" style={{ paddingTop: 70 }}>
            <LogoIcon style={{ width: 52, height: 52, opacity: 0.8 }} />
            <h2 style={{ margin: '6px 0 2px', color: 'var(--text-0)' }}>Welcome to CircuitDesk</h2>
            <p style={{ maxWidth: 460 }}>
              Build electronics projects with real boards, real wiring rules, a real compiler and a real AVR
              emulator. Start with the Blink starter — it compiles and runs out of the box.
            </p>
            <div className="empty-actions">
              <button className="btn primary" onClick={() => void createProject(() => buildBlinkProject('My First Project'))}>
                Create First Project
              </button>
              <button className="btn" onClick={() => navigate('#/templates')}>
                <LayersIcon style={{ width: 14, height: 14 }} /> Browse templates
              </button>
              <button className="btn" onClick={() => navigate('#/import')}>Import Project</button>
            </div>

          </div>
        ) : (
          <>
            <div className="dash-toolbar">
              <input type="search" placeholder="Search projects…" value={query} onChange={(e) => setQuery(e.target.value)} />
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                <option value="updated">Last edited</option>
                <option value="name">Name</option>
                <option value="created">Created</option>
              </select>
              <span style={{ color: 'var(--text-2)', fontSize: 12 }}>{filtered.length} project(s)</span>
            </div>

            {recent && !query && (
              <>
                <div className="dash-section-title">Recent</div>
                <div className="project-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}>
                  <ProjectCard meta={recent} onMenu={setMenu} />
                </div>
              </>
            )}

            <div className="dash-section-title">All projects</div>
            <div className="project-grid">
              {filtered.map((m) => (
                <ProjectCard key={m.id} meta={m} onMenu={setMenu} />
              ))}
              {filtered.length === 0 && <div className="empty-state">No projects match “{query}”.</div>}
            </div>

          </>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          entries={[
            { label: 'Open', onClick: () => navigate(`#/editor/${menu.meta.id}`) },
            { label: 'Rename…', onClick: () => setRenaming(menu.meta) },
            {
              label: 'Duplicate',
              onClick: () => {
                void duplicateProject(menu.meta.id).then((copy) => {
                  if (copy) {
                    toast(`Duplicated as “${copy.name}”`, 'success');
                    void refresh();
                  }
                });
              },
            },
            { label: 'Share to community…', onClick: () => navigate(`#/community?share=${encodeURIComponent(menu.meta.id)}`) },
            'sep',
            { label: 'Delete…', danger: true, onClick: () => setConfirmDelete(menu.meta) },
          ]}
        />
      )}

      {renaming && (
        <RenameModal
          meta={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={() => {
            setRenaming(null);
            void refresh();
          }}
        />
      )}

      {confirmDelete && (
        <Modal
          title="Delete project"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button
                className="btn danger"
                onClick={() => {
                  void deleteProject(confirmDelete.id).then(() => {
                    toast(`Deleted “${confirmDelete.name}”`);
                    setConfirmDelete(null);
                    void refresh();
                  });
                }}
              >
                Delete permanently
              </button>
            </>
          }
        >
          <p>
            Delete <strong>{confirmDelete.name}</strong>? This removes the project and its code from local storage
            and cannot be undone. Consider exporting it first.
          </p>
        </Modal>
      )}
    </div>
  );
}

function ProjectCard({ meta, onMenu }: { meta: ProjectMeta; onMenu: (m: { x: number; y: number; meta: ProjectMeta }) => void }) {
  return (
    <div
      className="project-card"
      onClick={() => navigate(`#/editor/${meta.id}`)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY, meta });
      }}
    >
      <div className="project-thumb">
        {meta.thumbnailSvg ? (
          // An image, not injected markup: an SVG drawn through <img> cannot run script.
          <img alt="" src={svgDataUrl(meta.thumbnailSvg)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <ChipIcon style={{ width: 34, height: 34, color: 'var(--text-2)' }} />
        )}
      </div>
      <div className="project-card-body">
        <div className="project-card-title">
          <span>{meta.name}</span>
          <button
            className="icon-btn"
            style={{ width: 22, height: 22 }}
            onClick={(e) => {
              e.stopPropagation();
              onMenu({ x: e.clientX, y: e.clientY, meta });
            }}
          >
            ⋯
          </button>
        </div>
        <div className="project-card-meta">
          <span>{meta.primaryBoard}</span>
          <span>{meta.componentCount} parts</span>
          <span>{timeAgo(meta.updatedAt)}</span>
        </div>
        <div className="project-card-footer">
          <SupportBadge level={meta.supportLevel} />
          <button className="btn sm" onClick={(e) => { e.stopPropagation(); navigate(`#/editor/${meta.id}`); }}>
            Open
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameModal({ meta, onClose, onRenamed }: { meta: ProjectMeta; onClose: () => void; onRenamed: () => void }) {
  const [name, setName] = useState(meta.name);
  const submit = async () => {
    const project = await loadProject(meta.id);
    if (project && name.trim()) {
      project.name = name.trim();
      project.updatedAt = new Date().toISOString();
      await saveProject(project);
      onRenamed();
    }
  };
  return (
    <Modal
      title="Rename project"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void submit()}>Rename</button>
        </>
      }
    >
      <input
        autoFocus
        style={{ width: '100%' }}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
      />
    </Modal>
  );
}
