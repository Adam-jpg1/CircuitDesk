import { UNITS_PER_MM, type PinCapability, type PinDefinition, type PinType } from '../types';

export const MM = UNITS_PER_MM;

export interface PinSpec {
  id: string;
  label: string;
  type?: PinType;
  caps?: PinCapability[];
  voltage?: number;
  maxCurrentMa?: number;
  aliases?: string[];
  number?: string;
  description?: string;
}

export function pinAt(spec: PinSpec, xMm: number, yMm: number): PinDefinition {
  return {
    id: spec.id,
    label: spec.label,
    number: spec.number,
    x: xMm * MM,
    y: yMm * MM,
    type: spec.type ?? 'digital',
    capabilities: spec.caps ?? ['digital-in', 'digital-out'],
    voltage: spec.voltage,
    maxCurrentMa: spec.maxCurrentMa,
    aliases: spec.aliases,
    description: spec.description,
  };
}

/** Lays out pins in a row at 2.54mm pitch starting at (xMm, yMm). */
export function pinRow(specs: (PinSpec | null)[], xMm: number, yMm: number, horizontal = true): PinDefinition[] {
  const out: PinDefinition[] = [];
  specs.forEach((spec, i) => {
    if (!spec) return;
    const x = horizontal ? xMm + i * 2.54 : xMm;
    const y = horizontal ? yMm : yMm + i * 2.54;
    out.push(pinAt(spec, x, y));
  });
  return out;
}

// Shorthand pin spec constructors.
export const gpio = (id: string, label: string, caps: PinCapability[] = ['digital-in', 'digital-out'], voltage = 5, extra: Partial<PinSpec> = {}): PinSpec => ({
  id,
  label,
  type: 'digital',
  caps,
  voltage,
  maxCurrentMa: voltage === 5 ? 20 : 12,
  ...extra,
});
export const analog = (id: string, label: string, voltage = 5, extra: Partial<PinSpec> = {}): PinSpec => ({
  id,
  label,
  type: 'analog',
  caps: ['analog-in', 'digital-in', 'digital-out'],
  voltage,
  maxCurrentMa: 20,
  ...extra,
});
export const gnd = (id: string, label = 'GND'): PinSpec => ({ id, label, type: 'ground', caps: ['ground'] });
export const p5v = (id: string, label = '5V'): PinSpec => ({ id, label, type: 'power-5v', caps: ['power'], voltage: 5, maxCurrentMa: 500 });
export const p3v3 = (id: string, label = '3V3'): PinSpec => ({ id, label, type: 'power-3v3', caps: ['power'], voltage: 3.3, maxCurrentMa: 250 });
export const vin = (id: string, label = 'VIN'): PinSpec => ({ id, label, type: 'power-vin', caps: ['power'], voltage: 9 });
export const reset = (id: string, label = 'RESET'): PinSpec => ({ id, label, type: 'reset', caps: ['digital-in'] });
export const nc = (id: string, label = 'NC'): PinSpec => ({ id, label, type: 'nc', caps: [] });
