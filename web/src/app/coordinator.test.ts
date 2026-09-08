import {afterEach, describe, expect, it, vi} from "vitest";
import {MetricCatalogQueryCoordinator} from "./coordinator";
import {ApiClient} from "../core/api-client";
import {recordReadWeight} from "../core/read-weight";

const instances: MetricCatalogQueryCoordinator[] = [];
const make = (budget = 1024): MetricCatalogQueryCoordinator => {
  const coordinator = new MetricCatalogQueryCoordinator(new ApiClient(), budget, 1000); instances.push(coordinator); return coordinator;
};
afterEach(() => {instances.forEach(item => item.destroy()); instances.length = 0; vi.useRealTimers();});
describe("shared read coordinator", () => {
  it("deduplicates concurrent consumers without letting one cancel the other", async () => {
    const coordinator = make();
    let finish!: (value: object) => void;
    const load = vi.fn(() => new Promise<object>(resolve => {finish = resolve;}));
    const a = new AbortController(), b = new AbortController();
    const first = coordinator.read("same", load, a.signal).catch(error => error.name);
    const second = coordinator.read("same", load, b.signal);
    a.abort(); finish({value: 5});
    expect(await first).toBe("AbortError"); expect(await second).toEqual({value: 5});
    expect(load).toHaveBeenCalledTimes(1);
    await coordinator.read("same", load, b.signal);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("releases expired reads by bytes and evicts oldest entries", async () => {
    vi.useFakeTimers();
    const coordinator = make(600);
    const signal = new AbortController().signal;
    const value = {small: 1}; recordReadWeight(value, 40);
    await coordinator.read("a", async () => value, signal);
    await coordinator.read("b", async () => value, signal);
    expect(coordinator.retainedBytes).toBe(320);
    await vi.advanceTimersByTimeAsync(1001);
    expect(coordinator.retainedBytes).toBe(0);
  });
  it("bounds concurrency and aborts queued work before transport starts", async () => {
    const coordinator = make();
    const controls = [new AbortController(), new AbortController(), new AbortController()];
    const releases: ((value: object) => void)[] = [];
    const load = vi.fn(() => new Promise<object>(resolve => releases.push(resolve)));
    const requests = controls.map((control, index) => coordinator.read(String(index), load, control.signal).catch(error => error.name));
    expect(load).toHaveBeenCalledTimes(2);
    controls[2]!.abort();
    releases.forEach(resolve => resolve({ok: true}));
    expect(await Promise.all(requests)).toEqual([{ok: true}, {ok: true}, "AbortError"]);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("caps point requests at 2000 and retains raw observation objects without cloning", async () => {
    const api = new ApiClient();
    const query = vi.spyOn(api, "query").mockResolvedValue({axis: "wall_time", series: []});
    const coordinator = new MetricCatalogQueryCoordinator(api); instances.push(coordinator);
    await coordinator.query({run_ids: ["b", "a"], paths: ["/loss"], max_points: 10000}, new AbortController().signal);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({run_ids: ["a", "b"], max_points: 2000}), expect.any(AbortSignal));
  });
});
