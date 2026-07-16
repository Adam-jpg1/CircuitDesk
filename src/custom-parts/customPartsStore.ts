import { create } from 'zustand';
import type { CustomDefinition } from '../types';
import { dbDeleteCustomPart, dbListCustomParts, dbPutCustomPart } from '../persistence/db';
import { setLibraryCustomParts } from '../project/partsRegistry';

interface CustomPartsState {
  parts: CustomDefinition[];
  loaded: boolean;
  refresh(): Promise<void>;
  add(part: CustomDefinition): Promise<void>;
  remove(definitionId: string): Promise<void>;
}

export const useCustomPartsStore = create<CustomPartsState>((set, get) => ({
  parts: [],
  loaded: false,
  async refresh() {
    try {
      const parts = await dbListCustomParts();
      setLibraryCustomParts(parts);
      set({ parts, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async add(part) {
    await dbPutCustomPart(part);
    await get().refresh();
  },
  async remove(definitionId) {
    await dbDeleteCustomPart(definitionId);
    await get().refresh();
  },
}));
