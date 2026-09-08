import {describe, expect, it, vi} from "vitest";
import {httpErrorMessage} from "./api-client";

describe("readable HTTP failures", () => {
  it("extracts the native JSON error while retaining the failed status", () => {
    expect(httpErrorMessage(400, '{"error":"Choose a narrower range."}', "application/json; charset=utf-8"))
      .toBe("Request failed (400): Choose a narrower range.");
    expect(httpErrorMessage(503, '"Temporarily unavailable"', "application/json"))
      .toBe("Request failed (503): Temporarily unavailable");
  });
  it("preserves plain errors and does not dump proxy HTML", () => {
    expect(httpErrorMessage(503, "Unavailable", "text/plain")).toBe("Request failed (503): Unavailable");
    expect(httpErrorMessage(502, "<html>Proxy error</html>", "text/html")).toBe("Request failed (502).");
    expect(httpErrorMessage(500, "", null)).toBe("Request failed (500).");
  });
  it("keeps structured message text literal for safe text rendering", () => {
    expect(httpErrorMessage(400, '{"error":"<resource> is unavailable"}', "application/json"))
      .toBe("Request failed (400): <resource> is unavailable");
  });
  it("reports malformed, oversized and missing JSON error details explicitly", () => {
    expect(httpErrorMessage(500, "{broken", "application/json")).toContain("malformed error details");
    expect(httpErrorMessage(500, JSON.stringify({error: "x".repeat(20_000)}), "application/json")).toContain("oversized error details");
    expect(httpErrorMessage(500, '{"error":42}', "application/json")).toContain("no readable error details");
    expect(httpErrorMessage(500, "x".repeat(401), "text/plain")).toBe(`Request failed (500): ${"x".repeat(400)}…`);
  });
  it("keeps authentication guidance and lets unexpected programming errors propagate", () => {
    expect(httpErrorMessage(401, "ignored", null)).toBe("Sign in to continue.");
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {throw new TypeError("Unexpected parser failure");});
    try {
      expect(() => httpErrorMessage(500, "{}", "application/json")).toThrow("Unexpected parser failure");
    } finally {parse.mockRestore();}
  });
});
