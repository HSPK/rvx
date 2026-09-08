import {afterEach, describe, expect, it, vi} from "vitest";
import {authenticationRestored, assertAuthenticated, getSession, requireAuthentication, returnPath, signIn} from "./session";

afterEach(() => {authenticationRestored(); vi.unstubAllGlobals();});
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status, headers: {"Content-Type": "application/json"}});
describe("cookie authentication client", () => {
  it("retains local workspace selections without accepting external redirects", () => {
    const origin = "https://rvx.example";
    expect(returnPath("/rvx?runs=one,two&range=3600", origin)).toBe("/rvx?runs=one,two&range=3600");
    for (const value of ["//evil.test", "https://evil.test", "/\\evil.test", "/rvx/../../login", "/login", "/rvx2", "/rvx\nx"]) {
      expect(returnPath(value, origin)).toBe("/rvx");
    }
  });
  it("suspends protected requests until sign-in is explicitly restored", () => {
    requireAuthentication(); expect(() => assertAuthenticated()).toThrow("Sign in");
    authenticationRestored(); expect(() => assertAuthenticated()).not.toThrow();
  });
  it("keeps password transport in a POST body and verifies the HttpOnly session through the server", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response({authenticated: true, authentication_required: true}));
    vi.stubGlobal("fetch", fetch);
    const state = await signIn("test-password-not-production", new AbortController().signal);
    expect(state.authenticated).toBe(true);
    expect(fetch.mock.calls[0]![0]).toBe("/api/auth/login");
    expect(fetch.mock.calls[0]![1]).toMatchObject({method: "POST", credentials: "same-origin", cache: "no-store",
      body: '{"password":"test-password-not-production"}'});
    expect(fetch.mock.calls[1]![0]).toBe("/api/auth/session");
  });
  it("does not claim successful sign-in if cookies were rejected", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({authenticated: true, authentication_required: true}))
      .mockResolvedValueOnce(response({authenticated: false, authentication_required: true})));
    await expect(signIn("test-password-not-production", new AbortController().signal)).rejects.toThrow("Allow cookies");
  });
  it("rejects malformed bootstrap state instead of treating it as local access", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({authenticated: true})));
    await expect(getSession(new AbortController().signal)).rejects.toThrow("invalid sign-in response");
  });
});
