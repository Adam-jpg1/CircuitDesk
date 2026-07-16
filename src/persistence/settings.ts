// UI settings stored in localStorage (small, non-binary data only).

const PREFIX = 'circuitdesk.';

export function loadSetting<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveSetting<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // storage full or unavailable — settings are non-critical
  }
}

export interface PanelSizes {
  left: number;
  right: number;
  bottom: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  bottomCollapsed: boolean;
}

export const DEFAULT_PANEL_SIZES: PanelSizes = {
  left: 248,
  right: 300,
  bottom: 260,
  leftCollapsed: false,
  rightCollapsed: false,
  bottomCollapsed: false,
};

export const PANEL_LIMITS = {
  left: { min: 180, max: 420 },
  right: { min: 220, max: 480 },
  bottom: { min: 120, maxVh: 75 },
};
