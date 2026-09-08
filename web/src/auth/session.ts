export interface SessionStatus {authenticated: boolean; authentication_required: boolean}
export const authenticationRequired = "rvx:authentication-required";
let blocked = false;

/** Preserve drafts on authentication loss instead of navigating away from the running workspace. */
export class AuthenticationRequired extends Error {
  constructor() {super("Sign in to continue.");}
}
/** Stop repeated protected reads while one sign-in form owns recovery. */
export function assertAuthenticated(): void {if (blocked) throw new AuthenticationRequired();}
/** Notify the application once, without storing credentials or exposing authentication state in URLs. */
export function requireAuthentication(): AuthenticationRequired {
  if (!blocked) {
    blocked = true;
    if (typeof window !== "undefined") window.dispatchEvent(new Event(authenticationRequired));
  }
  return new AuthenticationRequired();
}
/** Resume protected requests only after cookie authentication has been confirmed. */
export function authenticationRestored(): void {blocked = false;}
/** Recognize the small public session document before allowing authenticated navigation. */
function sessionStatus(value: unknown): SessionStatus {
  if (!value || typeof value !== "object" || !("authenticated" in value) || typeof value.authenticated !== "boolean"
    || !("authentication_required" in value) || typeof value.authentication_required !== "boolean") throw new Error("The server returned an invalid sign-in response.");
  return {authenticated: value.authenticated, authentication_required: value.authentication_required};
}
export class SignInError extends Error {
  constructor(message: string, readonly retryAfter = 0, readonly invalidPassword = false) {super(message);}
}
/** Use same-origin, uncached cookie transport; primary passwords never enter application storage. */
async function request(path: string, signal: AbortSignal, password?: string): Promise<Response> {
  const response = await fetch(path, {
    method: path.endsWith("/session") ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: {Accept: "application/json", ...(password === undefined ? {} : {"Content-Type": "application/json"})},
    ...(password === undefined ? {} : {body: JSON.stringify({password})}),
  });
  if (response.ok) return response;
  if (response.status === 401) throw new SignInError("Incorrect password. Try again.", 0, true);
  if (response.status === 429) {
    const retry = response.headers.get("retry-after") ?? "";
    const seconds = /^\d{1,4}$/.test(retry) ? Math.min(600, Number(retry)) : 30;
    throw new SignInError("Too many attempts. Please wait before trying again.", seconds);
  }
  if (response.status === 403) throw new SignInError("Sign-in was blocked. Open RVX at its configured server address.");
  throw new SignInError("Unable to connect to the sign-in service. Try again.");
}
/** Bootstrap authentication without reading private workspace preferences. */
export async function getSession(signal: AbortSignal): Promise<SessionStatus> {
  return sessionStatus(await (await request("/api/auth/session", signal)).json());
}
/** Verify that the browser retained the new cookie before reporting successful sign-in. */
export async function signIn(password: string, signal: AbortSignal): Promise<SessionStatus> {
  sessionStatus(await (await request("/api/auth/login", signal, password)).json());
  const status = await getSession(signal);
  if (!status.authenticated) throw new SignInError("Allow cookies for this server to sign in.");
  authenticationRestored();
  return status;
}
/** Revoke the current server session before the application discards its protected view. */
export async function signOut(signal: AbortSignal): Promise<void> {await request("/api/auth/logout", signal);}
/** Accept only same-origin workspace return paths, never external or protocol-relative redirects. */
export function returnPath(value: string | null, origin = location.origin): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value)) return "/rvx";
  let url: URL;
  try {url = new URL(value, origin);} catch {return "/rvx";}
  if (url.origin !== origin || !/^\/rvx(?:\/|$)/.test(url.pathname)) return "/rvx";
  return url.pathname + url.search + url.hash;
}
/** Preserve selected Runs and ranges when an initially unauthenticated document reaches the client. */
export function loginPath(): string {return `/login/?${new URLSearchParams({next: returnPath(location.pathname + location.search + location.hash)})}`;}
