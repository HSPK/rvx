import {describe, expect, it} from "vitest";

import type {ExperimentSource} from "../domain/types";
import {normalizeAxisValues} from "./chart-controller";
import {pipelineHealth} from "./views";

describe("RVX chart axes", () => {
  it("converts wall-time nanoseconds to uPlot seconds", () => {
    expect(
      normalizeAxisValues("wall_time", [
        1_788_454_000_000_000_000,
        1_788_454_010_000_000_000,
      ]),
    ).toEqual([1_788_454_000, 1_788_454_010]);
  });

  describe("RVX pipeline health", () => {
    const source = (
      state: ExperimentSource["state"],
      lastError: string | null = null,
    ): ExperimentSource => ({
      id: state,
      run_id: "run-1",
      attempt_id: "attempt-1",
      role: "hostmon",
      endpoint: state === "ended" ? "archive://history" : "http://localhost",
      node_id: "node-1",
      rank: null,
      state,
      source_session_id: null,
      last_success_at_ns: null,
      last_error: lastError,
      scrape_interval_ms: 1000,
      timeout_ms: 500,
      descriptor: null,
    });

    it("ignores ended history while a live source is active", () => {
      expect(pipelineHealth([source("ended"), source("active")])).toBe("OK");
    });

    it("distinguishes stale, lost, and completed roles", () => {
      expect(pipelineHealth([source("active"), source("stale")])).toBe("WARN");
      expect(pipelineHealth([source("lost")])).toBe("DOWN");
      expect(pipelineHealth([source("ended")])).toBe("ENDED");
    });
  });

  it("preserves logical axes", () => {
    expect(normalizeAxisValues("optimizer_step", [1, 2, 3])).toEqual([
      1,
      2,
      3,
    ]);
  });
});
