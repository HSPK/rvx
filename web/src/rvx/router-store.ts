export type BrowserPage =
  | "projects"
  | "project"
  | "experiment"
  | "runs"
  | "system";

export interface BrowserRoute {
  mode: "browser";
  page: BrowserPage;
  projectId?: string;
  experimentId?: string;
}

export interface WorkspaceRoute {
  mode: "workspace";
  runIds: string[];
  projectId?: string;
  experimentId?: string;
  returnTo: BrowserRoute;
}

export type RvxRoute = BrowserRoute | WorkspaceRoute;

export class RouterStore {
  private route: RvxRoute;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.route = this.readLocation();
    window.addEventListener("popstate", () => {
      this.route = this.readLocation();
      this.notify();
    });
  }

  private readLocation(): RvxRoute {
    const {pathname, search, hash} = window.location;
    const canonical = canonicalRvxUrl(pathname, search, hash);
    if (canonical !== pathname + search + hash) {
      window.history.replaceState(window.history.state, "", canonical);
    }
    return parseRvxRoute(window.location.pathname, window.location.search);
  }

  snapshot(): RvxRoute {
    return cloneRoute(this.route);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  navigate(route: BrowserRoute, replace = false): void {
    this.route = cloneRoute(route);
    this.commit(replace);
  }

  enterWorkspace(
    runIds: string[],
    context: {
      projectId?: string;
      experimentId?: string;
    } = {},
  ): void {
    const returnTo = this.route.mode === "browser"
      ? this.route
      : this.route.returnTo;
    this.route = {
      mode: "workspace",
      runIds: [...runIds],
      ...(context.projectId ? {projectId: context.projectId} : {}),
      ...(context.experimentId
        ? {experimentId: context.experimentId}
        : {}),
      returnTo: cloneBrowserRoute(returnTo),
    };
    this.commit(false);
  }

  leaveWorkspace(): void {
    if (this.route.mode !== "workspace") return;
    this.route = cloneBrowserRoute(this.route.returnTo);
    this.commit(false);
  }

  private commit(replace: boolean): void {
    const url = rvxRouteUrl(this.route);
    const state = cloneRoute(this.route);
    if (replace) window.history.replaceState(state, "", url);
    else window.history.pushState(state, "", url);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export function parseRvxRoute(pathname: string, search = ""): RvxRoute {
  const parts = canonicalUiPath(pathname).split("/").filter(Boolean);
  if (parts[0] !== "rvx") {
    return {mode: "browser", page: "projects"};
  }
  if (parts[1] === "workspace") {
    const query = new URLSearchParams(search);
    const runIds = query
      .get("runs")
      ?.split(",")
      .filter(Boolean) ?? [];
    const returnTo = parseReturnRoute(query.get("return"));
    return {
      mode: "workspace",
      runIds,
      ...(returnTo.projectId ? {projectId: returnTo.projectId} : {}),
      ...(returnTo.experimentId
        ? {experimentId: returnTo.experimentId}
        : {}),
      returnTo,
    };
  }
  if (parts[1] === "runs") return {mode: "browser", page: "runs"};
  if (parts[1] === "system") return {mode: "browser", page: "system"};
  if (parts[1] === "projects" && parts[2]) {
    if (parts[3] === "experiments" && parts[4]) {
      return {
        mode: "browser",
        page: "experiment",
        projectId: decodeURIComponent(parts[2]),
        experimentId: decodeURIComponent(parts[4]),
      };
    }
    return {
      mode: "browser",
      page: "project",
      projectId: decodeURIComponent(parts[2]),
    };
  }
  return {mode: "browser", page: "projects"};
}

export function rvxRouteUrl(route: RvxRoute): string {
  if (route.mode === "workspace") {
    const query = new URLSearchParams({
      runs: route.runIds.join(","),
      return: rvxRouteUrl(route.returnTo),
    });
    return `/rvx/workspace?${query}`;
  }
  if (route.page === "runs") return "/rvx/runs";
  if (route.page === "system") return "/rvx/system";
  if (route.page === "project" && route.projectId) {
    return `/rvx/projects/${encodeURIComponent(route.projectId)}`;
  }
  if (
    route.page === "experiment" &&
    route.projectId &&
    route.experimentId
  ) {
    return (
      `/rvx/projects/${encodeURIComponent(route.projectId)}` +
      `/experiments/${encodeURIComponent(route.experimentId)}`
    );
  }
  return "/rvx/projects";
}

function cloneRoute(route: RvxRoute): RvxRoute {
  return route.mode === "workspace"
    ? {
        ...route,
        runIds: [...route.runIds],
        returnTo: cloneBrowserRoute(route.returnTo),
      }
    : cloneBrowserRoute(route);
}

function cloneBrowserRoute(route: BrowserRoute): BrowserRoute {
  return {...route};
}

/** Canonicalizes legacy bookmarks without discarding unrelated query parameters. */
export function canonicalRvxUrl(pathname: string, search = "", hash = ""): string {
  const path = canonicalUiPath(pathname);
  if (path !== "/rvx" && !path.startsWith("/rvx/")) {
    return pathname + search + hash;
  }
  const query = search.replace(/([?&])([^&]*)/g, (parameter, prefix: string, value: string) => {
    const decoded = new URLSearchParams(value).get("return");
    if (decoded === null) return parameter;
    const canonical = canonicalUiPath(decoded);
    return canonical === decoded
      ? parameter
      : prefix + value.slice(0, value.indexOf("=") + 1) + encodeURIComponent(canonical);
  });
  return path + query + hash;
}

function canonicalUiPath(path: string): string {
  // Legacy UI routes only: never turn external URLs into navigation targets.
  return path.replace(/^\/ryx(?=\/|[?#]|$)/, "/rvx");
}

/** Parses a serialized Browser return path without allowing nested Workspaces. */
function parseReturnRoute(value: string | null): BrowserRoute {
  const fallback: BrowserRoute = {mode: "browser", page: "runs"};
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return fallback;
  }
  try {
    const url = new URL(canonicalUiPath(value), "http://rvx.local");
    if (
      url.origin !== "http://rvx.local" ||
      (url.pathname !== "/rvx" && !url.pathname.startsWith("/rvx/")) ||
      url.pathname.split("/").filter(Boolean)[1] === "workspace"
    ) return fallback;
    const route = parseRvxRoute(url.pathname, url.search);
    return route.mode === "browser" ? route : fallback;
  } catch {
    return fallback;
  }
}
