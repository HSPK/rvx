import {describe, expect, it} from "vitest";
import type {ExperimentRecord, ExperimentRun, ProjectRecord} from "../domain/types";
import {runObservationState, scopedRunLabels} from "./run-context";

const projects: ProjectRecord[] = [{id: "p1", name: "A", created_at_ns: 0}, {id: "p2", name: "B", created_at_ns: 0}];
const experiments: ExperimentRecord[] = [
  {id: "e1", name: "Training", project_id: "p1", created_at_ns: 0},
  {id: "e2", name: "Evaluation", project_id: "p1", created_at_ns: 0},
  {id: "e3", name: "Training", project_id: "p2", created_at_ns: 0},
];
const run = (id: string, name: string, experiment_id: string): ExperimentRun =>
  ({id, name, experiment_id, status: "running", config_json: "{}", created_at_ns: 0, updated_at_ns: 0});

describe("Run display identity", () => {
  it("leaves unique registry names unchanged", () => {
    const runs = [run("r1", "first", "e1"), run("r2", "second", "e2")];
    expect(scopedRunLabels(runs, experiments, projects).size).toBe(0);
    expect(runs.map(run => run.name)).toEqual(["first", "second"]);
  });
  it("adds experiment, then project, only when the names require it", () => {
    expect([...scopedRunLabels([run("r1", "trial", "e1"), run("r2", "trial", "e2")], experiments, projects).values()])
      .toEqual(["Training / trial", "Evaluation / trial"]);
    expect([...scopedRunLabels([run("r1", "trial", "e1"), run("r2", "trial", "e3")], experiments, projects).values()])
      .toEqual(["A / Training / trial", "B / Training / trial"]);
  });
  it("uses actual IDs for identical names within one experiment or missing scope", () => {
    expect([...scopedRunLabels([run("r1", "trial", "e1"), run("r2", "trial", "e1")], experiments, projects).values()])
      .toEqual(["[r1] trial", "[r2] trial"]);
    expect([...scopedRunLabels([run("r1", "trial", "missing"), run("r2", "trial", "missing")], [], []).values()])
      .toEqual(["[r1] trial", "[r2] trial"]);
  });
  it("does not collide with literal names that resemble qualified labels", () => {
    const runs = [run("r1", "trial", "e1"), run("r2", "trial", "e2"), run("r3", "Training / trial", "e2")];
    const labels = scopedRunLabels(runs, experiments, projects);
    expect(new Set(runs.map(run => labels.get(run.id) ?? run.name)).size).toBe(3);
  });
});

describe("individual observation age", () => {
  const running = run("r", "trial", "e1");
  const info = {run_id: "r", snapshot_count: 2, first_observed_at_ns: 0, last_observed_at_ns: 1000e6};
  it("marks only running Runs with old recorded observations", () => {
    expect(runObservationState(running, info, 200_000)).toBe("stale");
    expect(runObservationState({...running, status: "finished"}, info, 200_000)).toBeNull();
    expect(runObservationState(running, {...info, last_observed_at_ns: 190000e6}, 200_000)).toBeNull();
  });
  it("distinguishes no data from an unloaded catalog and supports a frozen assessment clock", () => {
    expect(runObservationState(running, undefined, 200_000)).toBeNull();
    expect(runObservationState(running, {...info, snapshot_count: 0, last_observed_at_ns: null}, 200_000)).toBe("empty");
    expect(runObservationState(running, info, 1000)).toBeNull();
  });
});
