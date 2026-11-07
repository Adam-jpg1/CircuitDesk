// A project's thumbnail is markup, and a project can come from anywhere.
//
// Before the community page, a project already arrived from outside whenever
// someone imported a .cdproj.json — and two things let it run script on the
// dashboard: the importer kept whatever `thumbnailSvg` the file carried, which
// the dashboard injected as HTML, and the thumbnail renderer wrote a wire's
// colour straight into an attribute. Publishing projects for strangers to open
// would have turned that into stored cross-site scripting. This tries both.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { renderProjectThumbnail, safeColour, svgDataUrl } from '../src/canvas/thumbnail';
import { normalizeProject } from '../src/project/projectService';
import { emptyProject } from '../src/project/templates';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const PAYLOAD = '"/><script>alert(document.cookie)</script><img src=x onerror="alert(1)';
const p = emptyProject('hostile');
p.boardInstances = [{ id: 'b', definitionId: 'board.arduino-uno', x: PAYLOAD as unknown as number, y: 10, rotation: 0, properties: {}, simulationState: {} }];
p.componentInstances = [{ id: 'l', definitionId: 'comp.led', x: 300, y: 40, rotation: 0, properties: {}, simulationState: {} }];
p.connections = [{
  id: 'w', sourceComponentId: 'b', sourcePinId: 'D13', targetComponentId: 'l', targetPinId: 'anode',
  netId: '', color: PAYLOAD, points: [], routing: 'smooth',
}];

const svg = renderProjectThumbnail(p);
check(!/<script/i.test(svg), 'a wire colour cannot put a <script> into the thumbnail');
check(!/onerror/i.test(svg) && !/<img/i.test(svg), 'nor an event handler');
check(/stroke="#2f9e44"/.test(svg), 'the colour is replaced with the default instead');
check(!svg.includes('alert'), 'and a position that is not a number becomes one');
check(safeColour('#e8590c') === '#e8590c' && safeColour('red; x') === '#2f9e44', 'real hex colours are kept, anything else is not');

const imported = normalizeProject(JSON.parse(JSON.stringify({ ...p, thumbnailSvg: `<svg>${PAYLOAD}</svg>` })));
check(imported.thumbnailSvg === undefined, 'an imported file cannot bring its own thumbnail markup');

const url = svgDataUrl(svg);
check(url.startsWith('data:image/svg+xml') && !url.includes('<'), 'thumbnails are handed to <img> as an encoded image URL');

// And nothing in the app injects markup any more.
const offenders: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(tsx|ts)$/.test(name) && readFileSync(full, 'utf8').includes('dangerouslySetInnerHTML')) offenders.push(full);
  }
};
walk('src');
check(offenders.length === 0, `no component injects raw HTML (${offenders.join(', ') || 'none'})`);

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
