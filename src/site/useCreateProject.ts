import { useCallback, useRef } from 'react';
import { saveProject } from '../project/projectService';
import { navigate, toast } from '../ui/primitives';
import type { CircuitProject } from '../types';

/**
 * Saves a new project and opens it, once per click.
 *
 * Guarded because a double click on a template card would otherwise create two
 * projects, and the second one is the one the user finds later and wonders
 * about.
 */
export function useCreateProject(): (build: () => CircuitProject) => Promise<void> {
  const busy = useRef(false);
  return useCallback(async (build: () => CircuitProject) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const project = build();
      await saveProject(project);
      navigate(`#/editor/${project.id}`);
    } catch (err) {
      console.error('[CircuitDesk] project creation failed:', err);
      toast('Could not create the project. See the browser console for details.', 'error');
    } finally {
      busy.current = false;
    }
  }, []);
}
