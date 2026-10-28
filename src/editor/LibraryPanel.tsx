import { useMemo, useState } from 'react';
import { useEditorStore } from '../app/editorStore';
import { useCustomPartsStore } from '../custom-parts/customPartsStore';
import { BOARD_DEFINITIONS } from '../boards/definitions';
import { COMPONENT_DEFINITIONS } from '../components-library/definitions';
import { SupportBadge } from '../ui/primitives';
import { describeSupport } from '../project/support';
import { loadSetting, saveSetting } from '../persistence/settings';
import { PART_SUMMARY, matchRank, partMatches } from '../components-library/partSearch';
import { useStudioStore } from '../board-studio/studioStore';
import { libraryBoards } from '../board-studio/boardLibrary';
import { embeddedBoards } from '../custom-boards/projectBoards';
import type { PartDefinition } from '../types';
import { partSize } from '../canvas/geometry';
import { isPhone, usePhoneLayout } from './phoneLayout';

/**
 * Shelf order.
 *
 * Roughly the order a project gets built in — board, the basics, the thing the
 * user is actually adding — rather than alphabetical, which would put Boards
 * halfway down. Categories with nothing in them are not rendered, so this list
 * can name shelves that are still being filled.
 */
const CATEGORY_ORDER = [
  'Favorites',
  'Boards',
  'Basic',
  'Inputs',
  'Keyboards & Keypads',
  'Sensors',
  'Displays',
  'LEDs',
  'Output',
  'Motors & Actuators',
  'Motors',
  'Communication',
  'Logic',
  'ICs',
  'Memory & Storage',
  'Memory',
  'Modules',
  'Power',
  'Instruments',
  'Prototyping',
  'Breadboards',
  'Connectors',
  'Input',
  'CircuitDesk Extras',
  'Custom boards',
  'Imported parts',
];

export function LibraryPanel() {
  const [query, setQuery] = useState('');
  const customParts = useCustomPartsStore((s) => s.parts);
  const project = useEditorStore((s) => s.project);
  const projectCustoms = project?.customDefinitions;
  const [favorites, setFavorites] = useState<string[]>(() => loadSetting<string[]>('favorites', []));

  const groups = useMemo(() => {
    const map = new Map<string, PartDefinition[]>();
    const push = (cat: string, def: PartDefinition) => {
      const arr = map.get(cat) ?? [];
      arr.push(def);
      map.set(cat, arr);
    };
    for (const b of BOARD_DEFINITIONS) push('Boards', b);
    for (const c of COMPONENT_DEFINITIONS) push(c.category, c);
    for (const p of customParts) push(p.source === 'import' ? 'Imported parts' : 'Custom boards', p.definition);
    for (const p of projectCustoms ?? []) push(p.source === 'import' ? 'Imported parts' : 'Custom boards', p.definition);
    const allById = new Map<string, PartDefinition>();
    for (const arr of map.values()) for (const d of arr) allById.set(d.id, d);
    const favs = favorites.map((id) => allById.get(id)).filter((d): d is PartDefinition => Boolean(d));
    if (favs.length > 0) map.set('Favorites', favs);

    const q = query.trim();
    const result: [string, PartDefinition[]][] = [];
    for (const cat of CATEGORY_ORDER) {
      const arr = map.get(cat);
      if (!arr || arr.length === 0) continue;
      // Matched on aliases as well as names, so "accelerometer" finds the
      // MPU6050 and "shift register" finds both 74HC parts.
      const filtered = q ? arr.filter((d) => partMatches(d, q)) : arr;
      if (filtered.length === 0) continue;
      // Best matches first within a shelf: an exact part number should not sit
      // below something that merely mentions it.
      if (q) filtered.sort((a, b) => matchRank(a, q) - matchRank(b, q));
      result.push([cat, filtered]);
    }
    return result;
  }, [query, customParts, projectCustoms, favorites]);

  const totalShown = groups.reduce((n, [, defs]) => n + defs.length, 0);

  const toggleFav = (id: string) => {
    setFavorites((prev) => {
      const next = prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id];
      saveSetting('favorites', next);
      return next;
    });
  };

  /**
   * The custom-board definitions reachable from here, by board id.
   *
   * Both places a board can live: the user's own library, and the copy embedded
   * in this project. The project's copy wins, because that is the revision this
   * project is actually built against and editing the other one would be
   * editing a different board than the one on the canvas.
   */
  const editableBoards = useMemo(() => {
    const byId = new Map(libraryBoards(customParts).map((b) => [b.id, b]));
    if (project) for (const [id, board] of embeddedBoards(project)) byId.set(id, board);
    return byId;
  }, [customParts, project]);

  return (
    <>
      <div className="panel-header">
        <span>Library</span>
      </div>
      <div className="library-actions">
        <button
          className="btn sm"
          data-testid="library-new-board"
          title="Make a board CircuitDesk does not have"
          onClick={() => useStudioStore.getState().openNew('My board')}
        >
          New board
        </button>
        <button
          className="btn sm"
          data-testid="library-open-board"
          title="Open a .cdboard.json somebody sent you"
          onClick={() => useStudioStore.getState().openStart()}
        >
          Open board file
        </button>
      </div>
      <div className="library-search">
        <input
          type="search"
          placeholder="Search parts — name, part number or what it does…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="panel-scroll">
        {groups.length === 0 && <div className="empty-state">No parts match “{query}”.</div>}
        {groups.map(([cat, defs]) => (
          <div key={cat}>
            <div className="library-cat">{cat}</div>
            {defs.map((def) => (
              <div
                key={`${cat}-${def.id}`}
                className="library-item"
                title={`${def.name}\n${def.description ?? ''}\nDrag onto the canvas, or double-click to place.`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('circuitdesk/part', def.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onDoubleClick={() => {
                  if (isPhone()) return;
                  const s = useEditorStore.getState();
                  const v = s.view;
                  s.addInstance(def.id, v.x + 320 / v.zoom, v.y + 200 / v.zoom);
                }}
                onClick={() => {
                  // No dragging between panes on a phone: a tap places the
                  // part in the middle of the canvas and shows it there.
                  if (!isPhone()) return;
                  const s = useEditorStore.getState();
                  const v = s.view;
                  const { w, h } = partSize(def);
                  s.addInstance(def.id, Math.round(v.x + window.innerWidth / 2 / v.zoom - w / 2), Math.round(v.y + window.innerHeight / 3 / v.zoom - h / 2));
                  usePhoneLayout.getState().setPane('circuit');
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  toggleFav(def.id);
                }}
              >
                <span className="li-thumb">
                  <MiniPartIcon def={def} />
                </span>
                {/* Name plus one scannable line: what it is and how it talks.
                    The full description stays on the tooltip. */}
                <span className="li-text">
                  <span className="li-name">{def.name}</span>
                  {PART_SUMMARY[def.id] && <span className="li-summary">{PART_SUMMARY[def.id]}</span>}
                </span>
                {editableBoards.has(def.id) && (
                  <button
                    className="btn sm"
                    data-testid={`library-edit-${def.id}`}
                    title="Open this board in the Board Studio"
                    onClick={(e) => {
                      e.stopPropagation();
                      const board = editableBoards.get(def.id);
                      if (board) useStudioStore.getState().openEdit(board);
                    }}
                  >
                    Edit
                  </button>
                )}
                <SupportBadge level={def.supportLevel} title={describeSupport(def)} />
              </div>
            ))}
          </div>
        ))}
        <div style={{ padding: '10px 12px', color: 'var(--text-2)', fontSize: 11 }}>
          {query.trim()
            ? `${totalShown} part${totalShown === 1 ? '' : 's'} match “${query.trim()}”. Search by what a part does — “accelerometer”, “shift register”, “distance” — as well as by part number.`
            : isPhone()
              ? 'Tap a part to place it on the canvas. Badges show honest support levels.'
              : 'Drag a part onto the canvas. Right-click a part to pin it to Favorites. Badges show honest support levels.'}
        </div>
      </div>
    </>
  );
}

function MiniPartIcon({ def }: { def: PartDefinition }) {
  const isBoard = Boolean(def.isBoard);
  const ratio = def.heightMm / def.widthMm;
  const w = 28;
  const h = Math.max(8, Math.min(22, w * ratio));
  const color = def.isBoard
    ? ((def.metadata.color as string) ?? '#155e8f')
    : def.category === 'Breadboards'
      ? '#d8dce0'
      : '#3a434d';
  return (
    <svg viewBox={`0 0 ${w} ${h + 2}`} width={w} height={h + 2}>
      <rect x="0.5" y="1" width={w - 1} height={h} rx="2.5" fill={color} stroke="rgba(0,0,0,0.4)" />
      {isBoard && <rect x={w / 2 - 5} y={h / 2 - 2.5} width="10" height="6" rx="1" fill="rgba(0,0,0,0.45)" />}
    </svg>
  );
}
