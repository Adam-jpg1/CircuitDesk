import { create } from 'zustand';
import type { CustomDefinition } from '../types';
import { dbDeleteCustomPart, dbListCustomParts, dbPutCustomPart } from '../persistence/db';
import { setLibraryCustomParts } from '../project/partsRegistry';
import { rederivedLibraryEntry } from '../board-studio/boardLibrary';

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
      // Custom boards are re-derived from their descriptions on the way in,
      // for the reason a project's are: what is stored contains both a
      // description and a conclusion drawn from it, and the store is not a
      // trust boundary.
      const parts = (await dbListCustomParts()).map(rederivedLibraryEntry);
      setLibraryCustomParts(parts);
      set({ parts, loaded: true });
    } catch (err) {
      console.error('[CircuitDesk] failed to load custom part library:', err);
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
