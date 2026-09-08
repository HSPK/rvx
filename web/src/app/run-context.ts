import type {ChartRunInfo} from "../domain/snapshots";
import type {ExperimentRecord, ExperimentRun, ProjectRecord} from "../domain/types";

/** Find ambiguous display strings without retaining an index for every unique Run. */
function duplicates(runs: ExperimentRun[], labels: ReadonlyMap<string, string>): Set<string> {
  const seen = new Set<string>(), repeated = new Set<string>();
  for (const run of runs) {
    const label = labels.get(run.id) ?? run.name;
    if (seen.has(label)) repeated.add(label); else seen.add(label);
  }
  return repeated;
}

/** Add only the registry scope needed to distinguish names, independently of current filters. */
export function scopedRunLabels(runs: ExperimentRun[], experiments: ExperimentRecord[], projects: ProjectRecord[]): ReadonlyMap<string, string> {
  const byExperiment = new Map(experiments.map(experiment => [experiment.id, experiment]));
  const byProject = new Map(projects.map(project => [project.id, project]));
  const labels = new Map<string, string>();
  for (let level = 0; level < 3; level++) {
    const repeated = duplicates(runs, labels);
    if (!repeated.size) return labels;
    for (const run of runs) {
      if (!repeated.has(labels.get(run.id) ?? run.name)) continue;
      const experiment = byExperiment.get(run.experiment_id);
      const project = experiment && byProject.get(experiment.project_id);
      const label = level === 0 && experiment ? `${experiment.name} / ${run.name}`
        : level === 1 && experiment && project ? `${project.name} / ${experiment.name} / ${run.name}`
        : `[${run.id}] ${run.name}`;
      labels.set(run.id, label);
    }
  }
  // Literal user names can imitate qualified labels; authoritative IDs remain unambiguous.
  if (duplicates(runs, labels).size) return new Map(runs.map(run => [run.id, `${run.name} [${run.id}]`]));
  return labels;
}

/** Assess each Run against the observation catalog's clock, not another Run's activity. */
export function runObservationState(run: ExperimentRun, info: ChartRunInfo | undefined, asOfMs: number): "empty" | "stale" | null {
  if (!info) return null;
  if (info.snapshot_count === 0) return "empty";
  if (run.status === "running" && info.last_observed_at_ns !== null && asOfMs - info.last_observed_at_ns / 1e6 > 120_000) return "stale";
  return null;
}
