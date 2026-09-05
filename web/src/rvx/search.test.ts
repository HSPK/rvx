import {describe, expect, it} from "vitest";

import type {
  ExperimentRecord,
  ExperimentRun,
  ExperimentSource,
  ProjectRecord,
} from "../domain/types";
import {matchesRunSearch} from "./search";

const project: ProjectRecord = {
  id: "project-1",
  name: "async-rl",
  created_at_ns: 1,
};
const experiment: ExperimentRecord = {
  id: "experiment-1",
  project_id: project.id,
  name: "grpo-v3",
  created_at_ns: 1,
};
const run: ExperimentRun = {
  id: "run-1",
  experiment_id: experiment.id,
  name: "trial-12",
  status: "running",
  config_json: "{}",
  created_at_ns: 1,
  updated_at_ns: 1,
};
const sources: ExperimentSource[] = [
  {
    id: "source-1",
    run_id: run.id,
    attempt_id: "attempt-1",
    role: "learner",
    endpoint: "http://learner-0:9200",
    node_id: "node-12",
    rank: 0,
    state: "active",
    source_session_id: "session-1",
    last_success_at_ns: 1,
    last_error: null,
    scrape_interval_ms: 1000,
    timeout_ms: 5000,
    descriptor: null,
  },
];

describe("RVX advanced run search", () => {
  it("matches plain text across the full run context", () => {
    expect(
      matchesRunSearch("learner", project, experiment, run, sources),
    ).toBe(true);
    expect(
      matchesRunSearch("trial-13", project, experiment, run, sources),
    ).toBe(false);
  });

  it("supports field filters and exclusions", () => {
    expect(
      matchesRunSearch(
        "project:async role:learner status:running -node:99",
        project,
        experiment,
        run,
        sources,
      ),
    ).toBe(true);
    expect(
      matchesRunSearch(
        "status:finished",
        project,
        experiment,
        run,
        sources,
      ),
    ).toBe(false);
  });

  it("supports quoted values", () => {
    expect(
      matchesRunSearch(
        'experiment:"grpo-v3" node:"node-12"',
        project,
        experiment,
        run,
        sources,
      ),
    ).toBe(true);
  });

  it("supports parameter equality and numeric comparisons", () => {
    const configured = {
      ...run,
      config_json: JSON.stringify({
        seed: 1,
        optimizer: {learning_rate: 0.0002},
      }),
    };

    expect(
      matchesRunSearch(
        "param.seed=1 param.optimizer.learning_rate>=0.0001",
        project,
        experiment,
        configured,
        sources,
      ),
    ).toBe(true);
  });
});
