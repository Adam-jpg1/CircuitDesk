import { useEditorStore } from './editorStore';
import { resolveWorkspaceTargets } from '../compiler/targets';
import { getSimulatorAdapter } from '../simulation/adapters';
import { simulationController } from '../simulation/simulationController';
import { useSimulationStore } from '../simulation/simulationStore';
import { validateProject } from '../validation/validator';
import { toast } from '../ui/primitives';

/**
 * Builds the workspace sketch for every board on the canvas.
 *
 * One editor source, one build per distinct target. A workspace with two Picos
 * and a C6 produces two artifacts, and each board instance runs its own copy —
 * two Picos share a file, never a CPU.
 *
 * A failure is reported as *that board's* failure. "Build failed" is not a true
 * statement about a workspace where the Pico built and only the C6 did not.
 */
export async function compileAction(run: boolean): Promise<boolean> {
  const s = useEditorStore.getState();
  const project = s.project;
  if (!project || s.compiling) return false;
  const { targets, unbuildable } = resolveWorkspaceTargets(project);
  if (targets.length === 0) {
    s.setBottomTab('compiler');
    toast(
      unbuildable[0]?.reason ??
        'Place a board on the canvas before compiling — there is no default compile target.',
      'error',
    );
    return false;
  }
  s.setCompiling(true);
  simulationController.onStage = (stage) => useEditorStore.getState().setCompileStage(stage);
  try {
    const report = await simulationController.build(project);
    // The compiler panel shows one target's diagnostics; the primary board's
    // are the ones a single-board project expects to see, and the per-target
    // summary carries the rest.
    const primary = report.builds.find((b) => b.result) ?? undefined;
    if (primary?.result) s.setLastCompile(primary.result);

    const failed = report.builds.filter((b) => b.status === 'compile-failed');
    const built = report.builds.filter((b) => b.status === 'built');
    if (failed.length > 0) {
      s.setBottomTab('compiler');
      // Name the boards. A user with a Pico and a C6 needs to know which one.
      toast(
        report.builds.map((b) => b.detail).join('\n'),
        built.length > 0 ? 'info' : 'error',
      );
      if (built.length === 0) return false;
    } else {
      toast(
        built.length === 1
          ? `${built[0].boardName} — build succeeded (${built[0].fqbn})`
          : `Built ${built.length} targets: ${built.map((b) => b.boardName).join(', ')}`,
        'success',
      );
    }

    if (run && report.anyRunnable) {
      simulationController.start();
      s.setBottomTab('serial');
    } else if (run) {
      toast(
        'The boards on this canvas compiled for their real hardware, but CircuitDesk cannot execute them yet.',
        'info',
      );
    }
    return failed.length === 0;
  } finally {
    simulationController.onStage = undefined;
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
    const { targets } = resolveWorkspaceTargets(project);
    if (targets.length > 0 && targets.every((t) => !getSimulatorAdapter(t.board))) {
      // Compile-capable but not simulated: build for the real targets and say so.
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
