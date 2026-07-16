import { useMemo, useState } from 'react';
import { useEditorStore } from '../app/editorStore';
import { useCustomPartsStore } from '../custom-parts/customPartsStore';
import { BOARD_DEFINITIONS } from '../boards/definitions';
import { COMPONENT_DEFINITIONS } from '../components-library/definitions';
import { SupportBadge } from '../ui/primitives';
import { loadSetting, saveSetting } from '../persistence/settings';
import type { PartDefinition } from '../types';

const CATEGORY_ORDER = [
  'Boards', 'Breadboards', 'Basic', 'Input', 'Output', 'Displays', 'Sensors', 'Motors',
  'Modules', 'Power', 'ICs', 'Connectors', 'Custom boards', 'Imported parts', 'Favorites',
];

export function LibraryPanel() {
  const [query, setQuery] = useState('');
  const customParts = useCustomPartsStore((s) => s.parts);
  const projectCustoms = useEditorStore((s) => s.project?.customDefinitions);
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

    const q = query.trim().toLowerCase();
    const result: [string, PartDefinition[]][] = [];
    for (const cat of CATEGORY_ORDER) {
      const arr = map.get(cat);
      if (!arr || arr.length === 0) continue;
      const filtered = q
        ? arr.filter((d) => d.name.toLowerCase().includes(q) || ('family' in d && d.family.toLowerCase().includes(q)))
        : arr;
      if (filtered.length > 0) result.push([cat, filtered]);
    }
    return result;
  }, [query, customParts, projectCustoms, favorites]);

  const toggleFav = (id: string) => {
    setFavorites((prev) => {
      const next = prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id];
      saveSetting('favorites', next);
      return next;
    });
  };

  return (
    <>
      <div className="panel-header">
        <span>Library</span>
      </div>
      <div className="library-search">
        <input
          type="search"
          placeholder="Search parts…"
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
                  const s = useEditorStore.getState();
                  const v = s.view;
                  s.addInstance(def.id, v.x + 320 / v.zoom, v.y + 200 / v.zoom);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  toggleFav(def.id);
                }}
              >
                <span className="li-thumb">
                  <MiniPartIcon def={def} />
                </span>
                <span className="li-name">{def.name}</span>
                <SupportBadge level={def.supportLevel} />
              </div>
            ))}
          </div>
        ))}
        <div style={{ padding: '10px 12px', color: 'var(--text-2)', fontSize: 11 }}>
          Drag a part onto the canvas. Right-click a part to pin it to Favorites. Badges show honest support levels.
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
