import {afterEach, describe, expect, it, vi} from "vitest";
import {PreferencesStore, validBrowserPreferences, validWorkspaceDocument, type UiState} from "./preferences";
import {emptyLayout} from "./panels";

const state = (): UiState => ({workspaces: {revision: 0, sets: []}, browser: {revision: 0, theme: "light", sidebar_width: 280, selected: {}, run_colors: {}}});
const response = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});
function server() {
  const data = state(), writes: {url: string; text: string; body: Record<string, unknown>}[] = [];
  const handle = async (url: string, init?: RequestInit): Promise<Response> => {
    if (!init?.body) return response(data);
    const text = String(init.body), body = JSON.parse(text); writes.push({url, text, body});
    if (url.endsWith("workspaces")) {data.workspaces = {revision: data.workspaces.revision + 1, sets: body.sets}; return response(data.workspaces);}
    data.browser = {revision: data.browser.revision + 1, theme: body.theme, sidebar_width: body.sidebar_width, selected: body.selected, run_colors: body.run_colors};
    return response(data.browser);
  };
  vi.stubGlobal("fetch", vi.fn(handle));
  return {data, writes, handle};
}
describe("server-owned UI preferences", () => {
  it("uses server-rendered appearance immediately without treating it as loaded preferences", async () => {
    const fixture = server();
    const store = new PreferencesStore(() => {}, () => {}, "dark");
    expect(store.data.theme).toBe("dark");
    expect(store.ready).toBe(false);
    expect(fixture.writes).toHaveLength(0);
    await store.bootstrap();
    expect(store.data.theme).toBe("light"); expect(store.ready).toBe(true);
    expect(fixture.writes).toHaveLength(0); store.destroy();
  });
  it("does not finish saving before its active workspace selection reaches the server", async () => {
    const fixture = server(), store = new PreferencesStore(); await store.bootstrap();
    let finish!: () => void;
    vi.mocked(fetch).mockImplementation(async (url, init) => String(url).endsWith("/browser")
      ? new Promise(resolve => {finish = () => {void fixture.handle(String(url), init).then(resolve);};})
      : fixture.handle(String(url), init));
    let settled = false;
    const saving = store.save("Durable selection", "experiment", emptyLayout()).then(value => {settled = true; return value;});
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(settled).toBe(false); expect(fixture.data.browser.selected).toEqual({});
    finish();
    const saved = await saving;
    expect(fixture.data.browser.selected.experiment).toBe(saved?.id); store.destroy();
  });
  it("bootstraps validated shared definitions and never accesses or writes local storage", async () => {
    const fixture = server();
    const local = {getItem: vi.fn(() => {throw new Error("must not read");}), setItem: vi.fn(() => {throw new Error("must not write");})};
    vi.stubGlobal("localStorage", local);
    const store = new PreferencesStore();
    expect(await store.bootstrap()).toBe(true);
    const layout = emptyLayout(), saved = await store.save("Shared", "experiment", layout);
    expect(saved?.name).toBe("Shared");
    await vi.waitFor(() => expect(fixture.data.browser.selected.experiment).toBe(saved?.id));
    const restored = new PreferencesStore(); await restored.bootstrap();
    expect(restored.selected("experiment")?.sections).toEqual(layout.sections);
    expect(local.getItem).not.toHaveBeenCalled(); expect(local.setItem).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith("/api/ui/state", expect.objectContaining({credentials: "same-origin", cache: "no-store"}));
    store.destroy(); restored.destroy();
  });
  it("keeps defaults usable but refuses writes after failed bootstrap, then explicitly retries", async () => {
    const fixture = server(), warn = vi.fn();
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Network unavailable"));
    const store = new PreferencesStore(warn);
    expect(await store.bootstrap()).toBe(false); expect(store.ready).toBe(false);
    expect(await store.save("Draft", "experiment", emptyLayout())).toBeNull();
    expect(fixture.writes).toHaveLength(0);
    await store.retry(); expect(store.ready).toBe(true);
    expect(await store.save("Draft", "experiment", emptyLayout())).not.toBeNull();
    store.destroy();
  });
  it("freezes submitted definitions and retries an uncertain outcome with the exact mutation bytes", async () => {
    const fixture = server(), store = new PreferencesStore(); await store.bootstrap();
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(async () => new Promise(resolve => {finish = resolve;}));
    const layout = emptyLayout(), pending = store.save("Frozen", "experiment", layout);
    layout.sections[0]!.name = "Edited after submission";
    finish(response({error: "Unavailable"}, 503));
    expect(await pending).toBeNull(); expect(store.uncertain).toBe(true);
    const firstBody = vi.mocked(fetch).mock.calls[1]![1]!.body;
    const saved = await store.retrySave();
    expect(saved?.sections[0]?.name).toBe("");
    expect(fixture.writes[0]?.text).toBe(firstBody);
    expect(store.uncertain).toBe(false); store.destroy();
  });
  it("preserves drafts on CAS conflicts without silently using the refreshed revision", async () => {
    const fixture = server(), store = new PreferencesStore(); await store.bootstrap();
    fixture.data.workspaces.revision = 3;
    vi.mocked(fetch).mockResolvedValueOnce(response({error: "revision conflict", current: fixture.data.workspaces}, 409));
    const layout = emptyLayout(); layout.sections[0]!.name = "Draft";
    expect(await store.save("Shared", "experiment", layout, 0)).toBeNull();
    expect(store.conflict?.revision).toBe(3); expect(store.uncertain).toBe(false);
    expect(layout.sections[0]!.name).toBe("Draft");
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    expect(await store.save("Shared copy", "experiment", layout, 3)).not.toBeNull();
    store.destroy();
  });
  it("serializes browser choices and coalesces edits made while an immutable request is pending", async () => {
    const fixture = server(), store = new PreferencesStore(); await store.bootstrap();
    let finish!: () => void;
    vi.mocked(fetch).mockImplementationOnce(async (url, init) => new Promise(resolve => {finish = () => {void fixture.handle(String(url), init).then(resolve);};}));
    store.updateBrowser({theme: "dark"});
    store.updateBrowser({sidebar_width: 310}); store.updateBrowser({sidebar_width: 420});
    expect(fixture.writes).toHaveLength(0);
    finish();
    await vi.waitFor(() => expect(fixture.writes).toHaveLength(2));
    expect(fixture.writes[0]?.body.sidebar_width).toBe(280);
    expect(fixture.writes[1]?.body).toMatchObject({revision: 1, theme: "dark", sidebar_width: 420});
    expect(store.workspaces.revision).toBe(0); store.destroy();
  });
  it("requires explicit retry for browser conflicts and preserves newer queued choices", async () => {
    const fixture = server(), store = new PreferencesStore(); await store.bootstrap();
    fixture.data.browser = {...fixture.data.browser, revision: 2, theme: "dark"};
    vi.mocked(fetch).mockResolvedValueOnce(response({error: "browser revision conflict", current: fixture.data.browser}, 409));
    store.updateBrowser({sidebar_width: 350});
    await vi.waitFor(() => expect(store.error).toContain("conflict"));
    store.updateBrowser({sidebar_width: 410});
    expect(fixture.writes).toHaveLength(0);
    await store.retry();
    expect(fixture.data.browser).toMatchObject({theme: "dark", sidebar_width: 410, revision: 3});
    store.destroy();
  });
  it("never evicts an unrelated workspace at capacity", async () => {
    const fixture = server();
    fixture.data.workspaces.sets = Array.from({length: 100}, (_, i) => ({id: `s${i}`, name: `Set ${i}`, experimentId: "experiment", ...emptyLayout()}));
    const store = new PreferencesStore(); await store.bootstrap();
    expect(await store.save("Overflow", "experiment", emptyLayout())).toBeNull();
    expect(fixture.writes).toHaveLength(0); expect(store.data.sets).toHaveLength(100); store.destroy();
  });
  it("successful browser writes and reconnect reads cannot conceal an unresolved workspace save", async () => {
    const fixture = server(), store = new PreferencesStore(); await store.bootstrap();
    vi.mocked(fetch).mockResolvedValueOnce(response({error: "Unknown save outcome"}, 503));
    await store.save("Pending", "experiment", emptyLayout());
    store.updateBrowser({theme: "dark"});
    await vi.waitFor(() => expect(fixture.data.browser.theme).toBe("dark"));
    await store.bootstrap();
    expect(store.error).toBe("Unknown save outcome"); expect(store.uncertain).toBe(true);
    expect(await store.retrySave()).not.toBeNull(); expect(store.error).toBe("");
    store.destroy();
  });
  it("late bootstrap snapshots cannot roll back a successfully saved document or browser selection", async () => {
    const fixture = server(), store = new PreferencesStore(); await store.bootstrap();
    const old = structuredClone(fixture.data);
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(async () => new Promise(resolve => {finish = resolve;}));
    const loading = store.bootstrap();
    const saved = await store.save("New", "experiment", emptyLayout());
    await vi.waitFor(() => expect(fixture.data.browser.selected.experiment).toBe(saved?.id));
    finish(response(old)); await loading;
    expect(store.workspaces.revision).toBe(1); expect(store.lastSavedRevision).toBe(1);
    expect(store.selected("experiment")?.id).toBe(saved?.id); store.destroy();
  });
  it("binds the saved baseline to its PUT revision, not a newer overlapping GET", async () => {
    const fixture = server(), store = new PreferencesStore(); await store.bootstrap();
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(async () => new Promise(resolve => {finish = resolve;}));
    const saving = store.save("Mine", "experiment", emptyLayout());
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[1]![1]!.body));
    fixture.data.workspaces = {revision: 2, sets: [{...body.sets[0], name: "Remote update"}]};
    await store.bootstrap();
    finish(response({revision: 1, sets: body.sets}));
    await saving;
    expect(store.workspaces.revision).toBe(2); expect(store.workspaces.sets[0]?.name).toBe("Remote update");
    expect(store.lastSavedRevision).toBe(1); store.destroy();
  });
  it("rejects invalid state documents and nested layouts", () => {
    expect(validBrowserPreferences({...state().browser, sidebar_width: 219})).toBe(false);
    expect(validBrowserPreferences({...state().browser, revision: -1})).toBe(false);
    expect(validWorkspaceDocument({revision: 1, sets: [{id: "x", name: "X", experimentId: "e", panels: [], sections: []}]})).toBe(false);
    expect(validWorkspaceDocument(null)).toBe(false);
  });
});
