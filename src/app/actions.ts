import { useEditorStore } from './editorStore';
import { compileProjectCode } from '../compiler/compilerClient';
import { resolveCompileTarget } from '../compiler/targets';
import { getSimulatorAdapter } from '../simulation/adapters';
import { simulationController } from '../simulation/simulationController';
import { useSimulationStore } from '../simulation/simulationStore';
import { validateProject } from '../validation/validator';
import { toast } from '../ui/primitives';

export async function compileAction(run: boolean): Promise<boolean> {
  const s = useEditorStore.getState();
  const project = s.project;
  if (!project || s.compiling) return false;
  const target = resolveCompileTarget(project);
  if (!target.ok) {
    s.setBottomTab('compiler');
    toast(target.reason, 'error');
    return false;
  }
  s.setCompiling(true);
  try {
    const result = await compileProjectCode(project, { boardId: target.boardId, fqbn: target.fqbn });
    s.setLastCompile(result);
    if (!result.success) {
      s.setBottomTab('compiler');
      toast(result.error ?? 'Compilation failed — see compiler output.', 'error');
      return false;
    }
    toast(
      `Compiled ${target.board.name} (${target.fqbn}) in ${(result.durationMs / 1000).toFixed(1)} s with ${result.toolchain}` +
        (result.memory ? ` — flash ${result.memory.flashBytes} B` : ''),
      'success',
    );
    const adapter = getSimulatorAdapter(target.board);
    if (result.firmware?.format === 'intel-hex' && adapter) {
      simulationController.loadFirmware(result.firmware.data, project, target.boardId);
      if (run) {
        simulationController.start();
        s.setBottomTab('serial');
      }
    } else if (run) {
      toast(
        `${target.board.name} compiled for the real hardware, but executing it inside CircuitDesk is not supported for this board.`,
        'info',
      );
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
  const project = s.project;
  if (project) {
    const target = resolveCompileTarget(project);
    if (target.ok && !getSimulatorAdapter(target.board)) {
      // Compile-capable but not simulated: build for the real target and say so.
      void compileAction(true);
      return;
    }
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
