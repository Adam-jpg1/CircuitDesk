// Every starter and showcase, on a page of their own.
//
// They used to be two rows at the bottom of the projects list, which is where
// you find them after you no longer need them. Here they are the point: each
// card shows the circuit itself, the board it runs on, the parts it uses and
// what it teaches, and says it is bench-tested only because it is — every
// template carries a test bench that the suite runs against compiled firmware.

import { useMemo, useState } from 'react';
import { emptyProject, PROJECT_TEMPLATES, type ProjectTemplate } from '../project/templates';
import { resolveDefinition } from '../project/partsRegistry';
import { projectPreview, renderPreviewSvg } from '../community/preview';
import { svgDataUrl } from '../canvas/thumbnail';
import { navigate } from '../ui/primitives';
import { CheckIcon, PlusIcon, SearchIcon, UsersIcon } from '../ui/icons';
import { SiteHeader } from './SiteHeader';
import { useCreateProject } from './useCreateProject';

export interface TemplateView {
  template: ProjectTemplate;
  previewUrl: string;
  parts: string[];
  architecture: string;
  tested: boolean;
}

/** Colour per architecture, so a board family is recognisable at a glance. */
export function architectureColour(architecture: string): string {
  if (architecture === 'avr') return '#3d9df2';
  if (architecture === 'rp2040') return '#e64980';
  if (architecture.startsWith('esp')) return '#20c997';
  return '#868e96';
}

let cached: TemplateView[] | null = null;
/** Each template built once, for its picture and its parts list. */
export function templateViews(): TemplateView[] {
  if (cached) return cached;
  cached = PROJECT_TEMPLATES.map((template) => {
    const project = template.build();
    const board = project.boardInstances[0];
    const def = board ? resolveDefinition(board.definitionId, project) : undefined;
    const names = project.componentInstances
      .map((i) => resolveDefinition(i.definitionId, project))
      .filter((d) => d && !d.isBoard && d.category !== 'Breadboards')
      .map((d) => d!.name.replace(/\s*\(.*\)$/, ''));
    return {
      template,
      previewUrl: svgDataUrl(renderPreviewSvg(projectPreview(project))),
      parts: [...new Set(names)],
      architecture: def?.isBoard ? (def.architecture ?? 'other') : 'other',
      tested: project.tests.length > 0,
    };
  });
  return cached;
}

type KindFilter = 'all' | 'starter' | 'showcase';

export function TemplatesPage() {
  const create = useCreateProject();
  const views = useMemo(templateViews, []);
  const [kind, setKind] = useState<KindFilter>('all');
  const [board, setBoard] = useState<string>('all');
  const [query, setQuery] = useState('');

  const boards = useMemo(() => [...new Set(views.map((v) => v.template.board))], [views]);
  const q = query.trim().toLowerCase();
  const matches = (v: TemplateView) =>
    (kind === 'all' || v.template.kind === kind) &&
    (board === 'all' || v.template.board === board) &&
    (!q ||
      [v.template.name, v.template.description, v.template.board, v.template.teaches ?? '', ...v.template.tags, ...v.parts]
        .join(' ')
        .toLowerCase()
        .includes(q));
  const starters = views.filter((v) => v.template.kind === 'starter' && matches(v));
  const showcases = views.filter((v) => v.template.kind === 'showcase' && matches(v));
  const filtering = kind !== 'all' || board !== 'all' || q !== '';
  const featured = !filtering ? views.find((v) => v.template.id === 'show.i2c-sensor-bus') : undefined;
  const testedCount = views.filter((v) => v.tested).length;

  return (
    <div className="dashboard">
      <SiteHeader
        active="templates"
        actions={
          <button className="btn primary" onClick={() => void create(() => emptyProject('Untitled Project'))}>
            <PlusIcon style={{ width: 14, height: 14 }} /> Blank project
          </button>
        }
      />
      <div className="dash-body site-page">
        <section className="site-hero">
          <div className="site-hero-text">
            <h1>Start from something that works</h1>
            <p>
              Every template is wired, compiles for its real board, and runs on the emulator — and{' '}
              {testedCount === views.length ? 'every one' : `${testedCount} of ${views.length}`} carries a test bench
              that proves it still does. Open one, press Run, then make it yours.
            </p>
            <div className="site-stats">
              <span><b>{views.filter((v) => v.template.kind === 'starter').length}</b> starters</span>
              <span><b>{views.filter((v) => v.template.kind === 'showcase').length}</b> showcases</span>
              <span><b>{boards.length}</b> boards</span>
              <span><b>{new Set(views.flatMap((v) => v.parts)).size}</b> kinds of part</span>
            </div>
          </div>
          {featured && (
            <div className="site-featured" onClick={() => void create(featured.template.build)} role="button" tabIndex={0}>
              <img alt="" src={featured.previewUrl} />
              <div className="site-featured-body">
                <span className="tpl-kind showcase">Featured showcase</span>
                <div className="site-featured-title">{featured.template.name}</div>
                <div className="site-featured-desc">{featured.template.teaches ?? featured.template.description}</div>
                <span className="tpl-cta">Open it →</span>
              </div>
            </div>
          )}
        </section>

        <div className="site-filters">
          <div className="segmented" role="tablist" aria-label="Kind">
            {(['all', 'starter', 'showcase'] as const).map((k) => (
              <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
                {k === 'all' ? 'All' : k === 'starter' ? 'Starters' : 'Showcases'}
              </button>
            ))}
          </div>
          <div className="chip-row" aria-label="Board">
            <button className={`chip${board === 'all' ? ' active' : ''}`} onClick={() => setBoard('all')}>Every board</button>
            {boards.map((b) => {
              const arch = views.find((v) => v.template.board === b)?.architecture ?? 'other';
              return (
                <button
                  key={b}
                  className={`chip${board === b ? ' active' : ''}`}
                  style={{ ['--arch' as string]: architectureColour(arch) }}
                  onClick={() => setBoard(board === b ? 'all' : b)}
                >
                  <span className="dot" /> {b}
                </button>
              );
            })}
          </div>
          <label className="site-search">
            <SearchIcon />
            <input type="search" placeholder="Search templates, parts, ideas…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>

        {(kind === 'all' || kind === 'starter') && (
          <>
            <div className="dash-section-title">Starter templates</div>
            <div className="dash-section-note">The smallest honest example of one idea each — read the sketch in a minute, then change it.</div>
            <div className="tpl-grid">
              {starters.map((v) => <TemplateCard key={v.template.id} view={v} onPick={() => void create(v.template.build)} />)}
              {!filtering && (
                <div className="template-card tpl-card tpl-blank" onClick={() => void create(() => emptyProject('Blank Project'))}>
                  <div className="tpl-blank-icon"><PlusIcon /></div>
                  <div className="t-name">Blank project</div>
                  <div className="t-desc">An empty canvas and an empty sketch.</div>
                </div>
              )}
              {starters.length === 0 && filtering && <div className="empty-state">No starter matches.</div>}
            </div>
          </>
        )}

        {(kind === 'all' || kind === 'showcase') && (
          <>
            <div className="dash-section-title" style={{ marginTop: 26 }}>Showcase projects</div>
            <div className="dash-section-note">
              Worked projects that drive real device models on real buses, across the boards that genuinely execute
              firmware.
            </div>
            <div className="tpl-grid">
              {showcases.map((v) => <TemplateCard key={v.template.id} view={v} onPick={() => void create(v.template.build)} />)}
              {showcases.length === 0 && <div className="empty-state">No showcase matches.</div>}
            </div>
          </>
        )}

        <div className="site-cta">
          <UsersIcon />
          <div>
            <b>Built something?</b> Share it with the community, or see what other people made.
          </div>
          <button className="btn" onClick={() => navigate('#/community')}>Explore the community →</button>
        </div>
      </div>
    </div>
  );
}

export function TemplateCard({ view, onPick }: { view: TemplateView; onPick: () => void }) {
  const t = view.template;
  const shown = view.parts.slice(0, 4);
  return (
    <div
      className="template-card tpl-card"
      data-template-id={t.id}
      onClick={onPick}
      onKeyDown={(e) => e.key === 'Enter' && onPick()}
      role="button"
      tabIndex={0}
      style={{ ['--arch' as string]: architectureColour(view.architecture) }}
    >
      <div className="tpl-preview">
        <img alt={`${t.name} circuit`} src={view.previewUrl} loading="lazy" />
        <span className={`tpl-kind ${t.kind}`}>{t.kind === 'starter' ? 'Starter' : 'Showcase'}</span>
      </div>
      <div className="tpl-body">
        <div className="t-board"><span className="dot" />{t.board}</div>
        <div className="t-name">{t.name}</div>
        <div className="t-desc">{t.description}</div>
        {t.teaches && <div className="t-teaches">{t.teaches}</div>}
        {shown.length > 0 && (
          <div className="tpl-parts">
            {shown.map((p) => <span key={p} className="part-chip">{p}</span>)}
            {view.parts.length > shown.length && <span className="part-chip more">+{view.parts.length - shown.length}</span>}
          </div>
        )}
        <div className="tpl-foot">
          {view.tested ? (
            <span className="tpl-tested" title="Carries a test bench that runs against the compiled firmware">
              <CheckIcon /> Bench-tested
            </span>
          ) : <span />}
          <span className="tpl-cta">Use template →</span>
        </div>
      </div>
    </div>
  );
}
