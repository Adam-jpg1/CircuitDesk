// Converts parse results into CircuitDesk definitions/projects.

import { uid, type BoardDefinition, type ComponentDefinition, type CustomDefinition, type PinDefinition, type SupportLevel, type CircuitProject } from '../types';
import { MM } from '../boards/pinHelpers';
import { emptyProject } from '../project/templates';
import type { GerberLayerData, ImportParseResult, ImportedPin } from './types';

export interface ImportOptions {
  name: string;
  widthMm: number;
  heightMm: number;
  supportLevel: SupportLevel;
  target: 'new-project' | 'existing-project' | 'custom-board' | 'custom-component' | 'visual-reference';
}

export function pinsToDefinitions(pins: ImportedPin[]): PinDefinition[] {
  return pins.map((p, i) => ({
    id: p.id || `pin${i}`,
    label: p.label || p.id || `Pin ${i + 1}`,
    x: p.xMm * MM,
    y: p.yMm * MM,
    type: p.type ?? 'passive',
    capabilities: (p.capabilities ?? []).filter((c): c is PinDefinition['capabilities'][number] =>
      ['digital-in', 'digital-out', 'analog-in', 'pwm', 'uart-tx', 'uart-rx', 'i2c-sda', 'i2c-scl', 'spi-mosi', 'spi-miso', 'spi-sck', 'spi-ss', 'interrupt', 'power', 'ground'].includes(c),
    ),
    voltage: p.voltage,
    maxCurrentMa: p.maxCurrentMa,
    description: p.notes,
  }));
}

function gerberToSvg(layers: GerberLayerData[], widthMm: number, heightMm: number): string {
  const colors: Record<GerberLayerData['kind'], string> = {
    copper: '#c9832a',
    silk: '#e8ebee',
    mask: '#1a5c38',
    outline: '#e8c35a',
    drill: '#10151b',
    other: '#7a8894',
  };
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthMm} ${heightMm}">`,
    `<rect width="${widthMm}" height="${heightMm}" fill="#14351f" rx="1"/>`,
  ];
  for (const layer of layers) {
    if (!layer.visible) continue;
    const color = colors[layer.kind];
    for (const path of layer.paths) {
      if (path.length < 2) continue;
      const d = `M ${path.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L ')}`;
      parts.push(`<path d="${d}" stroke="${color}" stroke-width="0.25" fill="none" stroke-linecap="round" opacity="0.9"/>`);
    }
    for (const f of layer.flashes) {
      parts.push(`<circle cx="${f.x.toFixed(2)}" cy="${f.y.toFixed(2)}" r="${(f.d / 2).toFixed(2)}" fill="${layer.kind === 'drill' ? '#10151b' : color}" opacity="0.9"/>`);
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

export function buildCustomDefinition(result: ImportParseResult, options: ImportOptions, pins: ImportedPin[]): CustomDefinition {
  const svg = result.svg ?? (result.layers ? gerberToSvg(result.layers, options.widthMm, options.heightMm) : undefined);
  const base = {
    id: uid(options.target === 'custom-component' ? 'customcomp' : 'customboard'),
    name: options.name,
    widthMm: options.widthMm,
    heightMm: options.heightMm,
    artwork: svg ? ({ kind: 'svg', svg } as const) : ({ kind: 'builtin', builtinId: 'generic' } as const),
    pins: pinsToDefinitions(pins),
    supportLevel: options.target === 'visual-reference' ? ('visual-only' as const) : options.supportLevel,
    description: `Imported from ${result.format} (${new Date().toLocaleDateString()}).${result.nets?.length ? ` Nets: ${result.nets.slice(0, 8).join(', ')}${result.nets.length > 8 ? '…' : ''}` : ''}`,
  };
  if (options.target === 'custom-component') {
    const def: ComponentDefinition = {
      ...base,
      category: 'Custom',
      properties: [],
      validationRules: [],
      isBoard: false,
    };
    return { kind: 'component', definition: def, createdAt: new Date().toISOString(), source: 'import' };
  }
  const def: BoardDefinition = {
    ...base,
    family: 'Imported',
    processor: (result.metadata?.processor as string) ?? 'unknown',
    metadata: { importFormat: result.format, ...(result.metadata ?? {}) },
    isBoard: true,
  };
  return { kind: 'board', definition: def, createdAt: new Date().toISOString(), source: 'import' };
}

export function buildProjectFromImport(result: ImportParseResult, options: ImportOptions, pins: ImportedPin[]): CircuitProject {
  if (result.project) return result.project;
  const project = emptyProject(options.name);
  const custom = buildCustomDefinition(result, options, pins);
  project.customDefinitions.push(custom);
  const inst = {
    id: uid('inst'),
    definitionId: custom.definition.id,
    x: 160,
    y: 140,
    rotation: 0,
    properties: {},
    simulationState: {},
  };
  if (custom.kind === 'board') project.boardInstances.push(inst);
  else project.componentInstances.push(inst);
  return project;
}
