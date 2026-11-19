import { describe, it, expect } from "vitest";
import { encodeSessionState, decodeSessionState } from "../src/pi/state-codec.js";

describe("snapshot encoding", () => {
  it("preserves small historical JSON", () => {
    const json = '{"version":2,"snippets":[],"calls":[],"stdout":""}';
    expect(encodeSessionState(json)).toBe(json);
    expect(decodeSessionState(json)).toBe(json);
  });
  it("compresses and restores large replay caches without changing any bytes", () => {
    const json = JSON.stringify({
      version: 2,
      snippets: Array.from({ length: 100 }, (_, i) => ({ code: "x = " + i })),
      calls: Array.from({ length: 300 }, (_, i) => ({
        key: "request-" + i,
        result: "some very repetitive historical context ".repeat(240),
      })),
      stdout: "ᚠ Unicode\n".repeat(160),
    });
    const encoded = encodeSessionState(json);
    expect(encoded.startsWith("pi-code-tool:gzip-v1:")).toBe(true);
    expect(encoded.length).toBeLessThan(json.length / 5);
    expect(decodeSessionState(encoded)).toBe(json);
  });
  it("rejects corrupted compressed data", () => {
    expect(() => decodeSessionState("pi-code-tool:gzip-v1:invalid")).toThrow();
  });
});
