// A harness that mounts the real Board Studio against the real stores.
//
// The Studio's claims are about what a person can and cannot end up with, so
// the test drives the actual components and reads the actual draft. Nothing is
// mocked between the two: a mocked store would only assert on itself.
//
// The one thing supplied here is a project, because "add to this project" is
// one of the outcomes being tested and there has to be a project to add to.

import { createRoot } from 'react-dom/client';
import { useEditorStore } from '../../src/app/editorStore';
import { useStudioStore } from '../../src/board-studio/studioStore';
import { BoardStudio } from '../../src/board-studio/BoardStudio';
import { emptyProject } from '../../src/project/templates';
import '../../src/ui/styles.css';

useEditorStore.setState({ project: emptyProject('board studio harness'), loading: false });
useStudioStore.getState().openNew('My board');

(window as unknown as Record<string, unknown>).studio = useStudioStore;
(window as unknown as Record<string, unknown>).editor = useEditorStore;

createRoot(document.getElementById('root')!).render(<BoardStudio />);
