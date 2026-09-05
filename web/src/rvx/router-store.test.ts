import {afterEach, describe, expect, it, vi} from "vitest";

import {canonicalRvxUrl, parseRvxRoute, RouterStore, rvxRouteUrl} from "./router-store";

afterEach(() => vi.unstubAllGlobals());

describe("RVX RouterStore", () => {
  it("parses Browser routes independently from Workspace tabs", () => {
    expect(parseRvxRoute("/rvx/projects/project-1")).toEqual({
      mode: "browser",
      page: "project",
      projectId: "project-1",
    });
  });

  describe("legacy UI route compatibility", () => {
    it("preserves workspace runs and canonicalizes legacy Browser return context", () => {
      const search = "?runs=run-1,run-2&filter=a%20b&return=%2Fryx%2Fprojects%2Fproject-1%2Fexperiments%2Fexperiment-1&filter=x+y";
      const canonical = canonicalRvxUrl("/ryx/workspace", search, "#details");
      expect(canonical).toBe(
        "/rvx/workspace?runs=run-1,run-2&filter=a%20b&return=%2Frvx%2Fprojects%2Fproject-1%2Fexperiments%2Fexperiment-1&filter=x+y#details",
      );
      expect(parseRvxRoute("/ryx/workspace", search)).toMatchObject({
        mode: "workspace",
        runIds: ["run-1", "run-2"],
        projectId: "project-1",
        experimentId: "experiment-1",
        returnTo: {mode: "browser", page: "experiment"},
      });
      expect(canonicalRvxUrl("/ryx", "?runs=one")).toBe("/rvx?runs=one");
      expect(canonicalRvxUrl("/ryx/", "?q=one")).toBe("/rvx/?q=one");
      expect(canonicalRvxUrl("/api/ryx", "?q=one")).toBe("/api/ryx?q=one");
      expect(canonicalRvxUrl("/ryx-other", "?q=one")).toBe("/ryx-other?q=one");
      expect(canonicalRvxUrl("/rvx/workspace", "?runs=run-1&%72eturn=%2Fryx%3Ffilter%3Dsaved")).toBe(
        "/rvx/workspace?runs=run-1&%72eturn=%2Frvx%3Ffilter%3Dsaved",
      );
      expect(parseRvxRoute("/rvx/workspace", "?runs=run-1&return=%2Fryx%3Ffilter%3Dsaved")).toMatchObject({
        returnTo: {mode: "browser", page: "projects"},
      });
    });

    it("replaces legacy URLs on initial load and popstate without losing history state", () => {
      let location = new URL("http://localhost/ryx/workspace?runs=run-1&return=%2Fryx%2Fruns#saved");
      let popstate = () => {};
      const history = {
        state: {saved: true},
        replaceState: vi.fn((_state: unknown, _title: string, url: string) => {
          location = new URL(url, location);
        }),
      };
      vi.stubGlobal("window", {
        get location() { return location; },
        history,
        addEventListener: (_name: string, listener: () => void) => { popstate = listener; },
      });
      const router = new RouterStore();
      expect(location.pathname + location.search + location.hash).toBe("/rvx/workspace?runs=run-1&return=%2Frvx%2Fruns#saved");
      expect(history.replaceState).toHaveBeenCalledWith({saved: true}, "", "/rvx/workspace?runs=run-1&return=%2Frvx%2Fruns#saved");
      expect(router.snapshot()).toMatchObject({mode: "workspace", runIds: ["run-1"]});
      location = new URL("http://localhost/ryx/projects/demo?filter=saved");
      popstate();
      expect(location.pathname + location.search).toBe("/rvx/projects/demo?filter=saved");
      expect(router.snapshot()).toEqual({mode: "browser", page: "project", projectId: "demo"});
    });

    it.each([
      "https://evil.example/ryx/runs",
      "//evil.example/rvx/runs",
      "/\\evil.example/rvx/runs",
      "javascript:alert(1)",
      "/api/status",
      "/ryx/workspace?return=%2Fryx%2Fworkspace",
      "/ryx//workspace?return=%2Fryx%2Fworkspace",
      "/rvx/projects/%",
    ])("rejects unsafe or nested return routes: %s", returnTo => {
      const route = parseRvxRoute("/rvx/workspace", `?runs=run-1&return=${encodeURIComponent(returnTo)}`);
      expect(route).toMatchObject({returnTo: {mode: "browser", page: "runs"}});
    });
  });

  it("serializes Browser and Workspace routes", () => {
    expect(rvxRouteUrl({
      mode: "browser",
      page: "experiment",
      projectId: "project-1",
      experimentId: "experiment-1",
    })).toBe("/rvx/projects/project-1/experiments/experiment-1");
    expect(rvxRouteUrl({
      mode: "workspace",
      runIds: ["run-1", "run-2"],
      returnTo: {mode: "browser", page: "runs"},
    })).toBe(
      "/rvx/workspace?runs=run-1%2Crun-2&return=%2Frvx%2Fruns",
    );
  });

  it("preserves Browser return context across Workspace reloads", () => {
    expect(parseRvxRoute(
      "/rvx/workspace",
      "?runs=run-1&return=%2Frvx%2Fprojects%2Fproject-1%2Fexperiments%2Fexperiment-1",
    )).toEqual({
      mode: "workspace",
      runIds: ["run-1"],
      projectId: "project-1",
      experimentId: "experiment-1",
      returnTo: {
        mode: "browser",
        page: "experiment",
        projectId: "project-1",
        experimentId: "experiment-1",
      },
    });
    expect(parseRvxRoute(
      "/rvx/workspace",
      "?runs=run-1&return=%2Frvx%2Fworkspace%3Fruns%3Drun-2",
    ).mode).toBe("workspace");
    expect(
      parseRvxRoute(
        "/rvx/workspace",
        "?runs=run-1&return=%2Frvx%2Fworkspace%3Fruns%3Drun-2",
      ),
    ).toMatchObject({
      returnTo: {mode: "browser", page: "runs"},
    });
  });
});
