import {describe, expect, it} from "vitest";

import type {ViewDefinition, WorkspaceState} from "./domain";
import {
  WorkspaceStore,
  type WorkspacePersistence,
} from "./workspace-store";

class MemoryPersistence implements WorkspacePersistence {
  value: WorkspaceState | null = null;
  saveCount = 0;

  load(): WorkspaceState | null {
    return this.value;
  }

  save(state: WorkspaceState): void {
    this.value = state;
    this.saveCount += 1;
  }
}

function runView(name: string): ViewDefinition {
  return {
    kind: "run-overview",
    title: name,
    runIds: [name],
  };
}

describe("RVX WorkspaceStore", () => {
  it("treats every tab as an independent view instance", () => {
    const store = new WorkspaceStore(new MemoryPersistence());

    const overview = store.open(runView("run-1"), {pinned: true});
    const metric = store.open({
      kind: "metric",
      title: "run-1 · loss",
      runIds: ["run-1"],
      metric: "train/loss",
    }, {pinned: true});

    expect(overview.id).not.toBe(metric.id);
    expect(store.snapshot().tabs).toHaveLength(2);
  });

  it("replaces only the unpinned preview in the same pane", () => {
    const store = new WorkspaceStore(new MemoryPersistence());
    const first = store.open(runView("run-1"), {preview: true});

    const second = store.open(runView("run-2"), {preview: true});

    expect(second.id).toBe(first.id);
    expect(store.snapshot().tabs).toHaveLength(1);
    expect(store.activeTab()?.view.runIds).toEqual(["run-2"]);
  });

  it("pins a preview after its state changes", () => {
    const store = new WorkspaceStore(new MemoryPersistence());
    const preview = store.open(runView("run-1"), {preview: true});

    store.updateState(preview.id, {axis: "optimizer_step"});

    const tab = store.activeTab();
    expect(tab?.preview).toBe(false);
    expect(tab?.pinned).toBe(true);
    expect(tab?.state.axis).toBe("optimizer_step");
  });

  it("keeps view state isolated across panes and persistence", () => {
    const persistence = new MemoryPersistence();
    const store = new WorkspaceStore(persistence);
    const first = store.open(runView("run-1"), {pinned: true});
    const second = store.open(runView("run-2"), {
      pane: "secondary",
      pinned: true,
    });

    store.updateState(first.id, {axis: "env_step"});
    store.updateState(second.id, {axis: "policy_version"});

    const restored = new WorkspaceStore(persistence);

    expect(restored.snapshot().secondaryVisible).toBe(true);
    expect(
      restored.snapshot().tabs.find(tab => tab.id === first.id)?.state.axis,
    ).toBe("env_step");
    expect(
      restored.snapshot().tabs.find(tab => tab.id === second.id)?.state.axis,
    ).toBe("policy_version");
  });

  it("does not render a moved active tab in both panes", () => {
    const store = new WorkspaceStore(new MemoryPersistence());
    const first = store.open(runView("run-1"), {pinned: true});
    const second = store.open(runView("run-2"), {pinned: true});

    store.move(second.id, "secondary");

    expect(store.activeTab("primary")?.id).toBe(first.id);
    expect(store.activeTab("secondary")?.id).toBe(second.id);
  });

  it("duplicates and restores closed views as new tab instances", () => {
    const store = new WorkspaceStore(new MemoryPersistence());
    const source = store.open(runView("run-1"), {pinned: true});
    const duplicate = store.duplicate(source.id);
    expect(duplicate?.id).not.toBe(source.id);

    store.close(source.id);
    const restored = store.restoreClosed();

    expect(restored?.id).not.toBe(source.id);
    expect(restored?.view).toEqual(source.view);
  });

  it("persists editable metric sections independently per view", () => {
    const persistence = new MemoryPersistence();
    const store = new WorkspaceStore(persistence);
    const metric = store.open({
      kind: "metric",
      title: "loss",
      runIds: ["run-1"],
      metric: "train/loss",
    }, {pinned: true});
    store.updateState(metric.id, {
      metricSections: [
        {
          id: "training",
          title: "Training",
          columns: 2,
          panelHeight: 240,
          panels: [
            {
              id: "loss-chart",
              type: "chart",
              title: "Loss",
              metrics: ["train/loss"],
            },
            {
              id: "rate-table",
              type: "table",
              title: "Rates",
              metrics: ["train/throughput"],
            },
          ],
        },
      ],
    });

    const restored = new WorkspaceStore(persistence).activeTab();

    expect(restored?.state.metricSections[0]?.title).toBe("Training");
    expect(restored?.state.metricSections[0]?.panels).toHaveLength(2);
  });

  it("atomically replaces stale tabs for a new routed Workspace", () => {
    const persistence = new MemoryPersistence();
    const store = new WorkspaceStore(persistence);
    store.open(runView("run-1"), {pinned: true});

    const compare = store.replace({
      kind: "compare",
      title: "2 Runs",
      runIds: ["run-2", "run-3"],
    }, {pinned: true});

    expect(persistence.saveCount).toBe(2);
    expect(store.snapshot().tabs).toHaveLength(1);
    expect(store.activeTab()?.id).toBe(compare.id);
    expect(store.activeTab()?.view.runIds).toEqual(["run-2", "run-3"]);
  });
});
