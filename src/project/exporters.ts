import JSZip from 'jszip';
import type { CircuitProject, TestResult } from '../types';
import { resolveDefinition } from './partsRegistry';
import { buildCircuitGraph, splitNode } from '../circuit/nets';
import { validateProject } from '../validation/validator';
import { downloadFile } from '../ui/primitives';

function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportProjectJson(project: CircuitProject): void {
  const clean: CircuitProject = { ...project, thumbnailSvg: undefined };
  downloadFile(
    `${project.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.cdproj.json`,
    JSON.stringify({ app: 'CircuitDesk', kind: 'circuitdesk-project', ...clean }, null, 2),
    'application/json',
  );
}

export function buildBomCsv(project: CircuitProject): string {
  const counts = new Map<string, { name: string; category: string; count: number; props: string }>();
  for (const inst of [...project.boardInstances, ...project.componentInstances]) {
    const def = resolveDefinition(inst.definitionId, project);
    if (!def) continue;
    const props = Object.entries(inst.properties)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    const key = `${def.id}|${props}`;
    const cur = counts.get(key);
    if (cur) cur.count++;
    else counts.set(key, { name: def.name, category: def.isBoard ? 'Board' : def.category, count: 1, props });
  }
  const rows = [['Part', 'Category', 'Quantity', 'Properties']];
  for (const { name, category, count, props } of counts.values()) rows.push([name, category, String(count), props]);
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n');
}

export function buildPinMapCsv(project: CircuitProject): string {
  const rows = [['board', 'pin', 'label', 'type', 'x_mm', 'y_mm', 'voltage', 'maxCurrentMa', 'capabilities']];
  for (const inst of project.boardInstances) {
    const def = resolveDefinition(inst.definitionId, project);
    if (!def) continue;
    for (const pin of def.pins) {
      rows.push([
        def.name, pin.id, pin.label, pin.type,
        (pin.x / 4).toFixed(2), (pin.y / 4).toFixed(2),
        pin.voltage != null ? String(pin.voltage) : '', pin.maxCurrentMa != null ? String(pin.maxCurrentMa) : '',
        pin.capabilities.join('|'),
      ]);
    }
  }
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n');
}

export function buildWiringReport(project: CircuitProject): string {
  const graph = buildCircuitGraph(project);
  const instName = (id: string) => {
    const inst = graph.instances.find((i) => i.id === id);
    const def = inst ? graph.definitions.get(id) : undefined;
    return inst?.label || def?.name || id;
  };
  const pinLabel = (instId: string, pinId: string) => {
    const def = graph.definitions.get(instId);
    return def?.pins.find((p) => p.id === pinId)?.label ?? pinId;
  };
  const lines: string[] = [
    `CircuitDesk wiring report — ${project.name}`,
    `Generated ${new Date().toISOString()}`,
    '',
    `Connections (${project.connections.length}):`,
  ];
  project.connections.forEach((c, i) => {
    lines.push(
      `  ${String(i + 1).padStart(2)}. ${instName(c.sourceComponentId)} [${pinLabel(c.sourceComponentId, c.sourcePinId)}] ↔ ` +
        `${instName(c.targetComponentId)} [${pinLabel(c.targetComponentId, c.targetPinId)}] (${c.color})`,
    );
  });
  lines.push('', `Nets (${graph.nets.length}):`);
  graph.nets
    .filter((n) => n.nodes.length > 1)
    .forEach((net, i) => {
      const nodes = net.nodes.map((n) => {
        const [instId, pinId] = splitNode(n);
        return `${instName(instId)}.${pinLabel(instId, pinId)}`;
      });
      lines.push(`  net ${i + 1}: ${nodes.join(' — ')}`);
    });
  return lines.join('\n');
}

export function buildValidationReport(project: CircuitProject): string {
  const issues = validateProject(project);
  const lines = [
    `CircuitDesk validation report — ${project.name}`,
    `Generated ${new Date().toISOString()}`,
    '',
    issues.length === 0 ? 'No issues found.' : `${issues.length} issue(s):`,
  ];
  for (const i of issues) {
    lines.push('', `[${i.severity.toUpperCase()}] ${i.title}`, `  ${i.description}`);
    if (i.why) lines.push(`  Why it matters: ${i.why}`);
    if (i.suggestedFix) lines.push(`  Suggested fix: ${i.suggestedFix}`);
  }
  return lines.join('\n');
}

export function buildTestReport(project: CircuitProject, results: Map<string, TestResult>): string {
  const lines = [
    `CircuitDesk test report — ${project.name}`,
    `Generated ${new Date().toISOString()}`,
    '',
  ];
  for (const test of project.tests) {
    const r = results.get(test.id);
    lines.push(`${test.name}: ${r ? r.status.toUpperCase() : 'NOT RUN'}${r ? ` (${(r.durationMs / 1000).toFixed(1)} s)` : ''}`);
    if (r) {
      for (const a of r.assertionResults) {
        lines.push(`  ${a.passed ? 'PASS' : 'FAIL'} — expected ${a.expected}; actual: ${a.actual}`);
      }
      if (r.message) lines.push(`  note: ${r.message}`);
    }
  }
  return lines.join('\n');
}

export async function exportProjectZip(project: CircuitProject, results: Map<string, TestResult>): Promise<void> {
  const zip = new JSZip();
  const clean = { app: 'CircuitDesk', kind: 'circuitdesk-project', ...project, thumbnailSvg: undefined };
  zip.file('project.cdproj.json', JSON.stringify(clean, null, 2));
  for (const f of project.codeFiles) zip.file(`code/${f.name}`, f.content);
  zip.file('reports/bom.csv', buildBomCsv(project));
  zip.file('reports/pinmap.csv', buildPinMapCsv(project));
  zip.file('reports/wiring.txt', buildWiringReport(project));
  zip.file('reports/validation.txt', buildValidationReport(project));
  if (project.tests.length > 0) zip.file('reports/tests.txt', buildTestReport(project, results));
  if (project.settings.assemblyNotes) zip.file('reports/assembly-notes.txt', project.settings.assemblyNotes);
  if (project.thumbnailSvg) zip.file('thumbnail.svg', project.thumbnailSvg);
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadFile(`${project.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.circuitdesk.zip`, blob);
}

export function exportBoardDefinition(project: CircuitProject): void {
  const inst = project.boardInstances[0];
  const def = inst ? resolveDefinition(inst.definitionId, project) : undefined;
  if (!def) return;
  downloadFile(`${def.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.board.json`, JSON.stringify({ app: 'CircuitDesk', kind: 'board-definition', definition: def }, null, 2), 'application/json');
}

export function exportProjectImage(project: CircuitProject): void {
  if (!project.thumbnailSvg) return;
  downloadFile(`${project.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.svg`, project.thumbnailSvg, 'image/svg+xml');
}
