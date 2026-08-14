// A harness that mounts the real key panel against the real stores.
//
// The panel's whole claim is that it presses the same contacts the canvas does
// and lets go of all of them when it closes. That claim is about what it puts
// in the simulation store, so the test drives this page and reads the store —
// no mock of either sits in between.

import { createRoot } from 'react-dom/client';
import { useEditorStore } from '../../src/app/editorStore';
import { useSimulationStore } from '../../src/simulation/simulationStore';
import { KeyMatrixOverlay } from '../../src/editor/KeyMatrixOverlay';
import { emptyProject } from '../../src/project/templates';
import '../../src/ui/styles.css';

const project = emptyProject('key panel harness');
const instance = {
  id: 'kb1',
  definitionId: new URLSearchParams(location.search).get('part') ?? 'comp.mini-keyboard',
  x: 0,
  y: 0,
  rotation: 0,
  properties: {},
  simulationState: {},
};
project.componentInstances.push(instance);
useEditorStore.setState({ project, keyPanelInstanceId: instance.id });
// The panel only closes contacts while something is running, which is also true
// of the canvas: a stopped simulation has no contact state to hold.
useSimulationStore.setState({ status: 'running' });

// The panel draws a key as down when the simulation says the contact is closed,
// not when it thinks it pressed one — same as the part on the canvas. With no
// binding running here, this is the one line of the binding it depends on:
// circuitSim publishes exactly this map for a keypad.
useSimulationStore.subscribe((s) => {
  const prefix = `${instance.id}#`;
  const contacts: Record<string, boolean> = {};
  for (const key of s.pressedButtons) {
    if (key.startsWith(prefix)) contacts[key.slice(prefix.length)] = true;
  }
  const current = s.visuals[instance.id]?.contacts ?? {};
  const same =
    Object.keys(contacts).length === Object.keys(current).length &&
    Object.keys(contacts).every((k) => current[k]);
  if (!same) useSimulationStore.setState({ visuals: { [instance.id]: { contacts } } });
});

// Handed to the test, which asserts on the store rather than on the pixels.
(window as unknown as Record<string, unknown>).sim = useSimulationStore;
(window as unknown as Record<string, unknown>).editor = useEditorStore;

function Host() {
  const id = useEditorStore((s) => s.keyPanelInstanceId);
  if (!id) return <div data-testid="closed">closed</div>;
  return <KeyMatrixOverlay instanceId={id} onClose={() => useEditorStore.getState().setKeyPanel(null)} />;
}

createRoot(document.getElementById('root')!).render(<Host />);
