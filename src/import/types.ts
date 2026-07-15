import type { CircuitProject, PinType } from '../types';

export interface ImportedPin {
  id: string;
  label: string;
  xMm: number;
  yMm: number;
  type?: PinType;
  net?: string;
  notes?: string;
  voltage?: number;
  maxCurrentMa?: number;
  capabilities?: string[];
}

export interface ImportedComponentRef {
  name: string;
  xMm: number;
  yMm: number;
  footprint?: string;
}

export interface GerberLayerData {
  name: string;
  kind: 'copper' | 'silk' | 'mask' | 'outline' | 'drill' | 'other';
  /** polylines in mm */
  paths: { x: number; y: number }[][];
  /** flashed pads / drill holes in mm */
  flashes: { x: number; y: number; d: number }[];
  visible: boolean;
}

export interface ImportParseResult {
  format:
    | 'circuitdesk'
    | 'csv'
    | 'kicad'
    | 'fritzing'
    | 'eagle'
    | 'easyeda'
    | 'gerber'
    | 'svg'
    | 'zip-bundle';
  name: string;
  warnings: string[];
  /** full project restore (CircuitDesk JSON) */
  project?: CircuitProject;
  /** connection points extracted from the source */
  pins?: ImportedPin[];
  outline?: { widthMm: number; heightMm: number };
  svg?: string;
  imageDataUrl?: string;
  csv?: { headers: string[]; rows: string[][] };
  components?: ImportedComponentRef[];
  nets?: string[];
  layers?: GerberLayerData[];
  objectCounts?: Record<string, number>;
  metadata?: Record<string, unknown>;
}

export class ImportError extends Error {}

export const MAX_IMPORT_BYTES = 40 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 400;
