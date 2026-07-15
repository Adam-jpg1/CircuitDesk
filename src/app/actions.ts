import { useEditorStore } from './editorStore';
import { compileProjectCode } from '../compiler/compilerClient';
import { simulationController } from '../simulation/simulationController';
import { useSimulationStore } from '../simulation/simulationStore';
import { validateProject } from '../validation/validator';
import { toast } from '../ui/primitives';

export async function compileAction(run: boolean): Promise<boolean> {
  const s = useEditorStore.getState();
  const project = s.project;
  if (!project || s.compiling) return false;
  s.setCompiling(true);
  try {
    const result = await compileProjectCode(project);
    s.setLastCompile(result);
    if (!result.success) {
      s.setBottomTab('compiler');
      toast(result.error ?? 'Compilation failed — see compiler output.', 'error');
      return false;
    }
    if (result.firmware) {
      simulationController.loadFirmware(result.firmware.data, project);
      toast(
        `Compiled in ${(result.durationMs / 1000).toFixed(1)} s with ${result.toolchain}` +
          (result.memory ? ` — flash ${result.memory.flashBytes} B` : ''),
        'success',
      );
      if (run) {
        simulationController.start();
        s.setBottomTab('serial');
      }
    }
    return true;
  } finally {
    useEditorStore.getState().setCompiling(false);
  }
}

export function runAction(): void {
  const s = useEditorStore.getState();
  const simStatus = useSimulationStore.getState().status;
  if (simStatus === 'paused') {
    simulationController.start();
    return;
  }
  if (simulationController.hasFirmware && s.lastCompile?.success) {
    if (s.project) simulationController.refreshCircuit(s.project);
    simulationController.start();
    s.setBottomTab('serial');
  } else {
    void compileAction(true);
  }
}

export function validateAction(): void {
  const s = useEditorStore.getState();
  if (!s.project) return;
  const issues = validateProject(s.project);
  s.setValidationIssues(issues);
  s.setBottomTab('validation');
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  toast(
    issues.length === 0
      ? 'Validation passed — no issues found.'
      : `Validation: ${errors} error(s), ${warnings} warning(s).`,
    errors > 0 ? 'error' : issues.length === 0 ? 'success' : 'info',
  );
}
