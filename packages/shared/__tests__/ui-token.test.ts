import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateUiToken, validateUiToken } from "../src/ui-token.js";

const SECRET = "test-bridge-auth-token-32bytes!!";

describe("generateUiToken", () => {
  it("should return a token with 3 dot-separated parts", () => {
    const token = generateUiToken(SECRET);
    expect(token.split(".")).toHaveLength(3);
  });

  it("should produce different tokens on each call", () => {
    const a = generateUiToken(SECRET);
    const b = generateUiToken(SECRET);
    expect(a).not.toBe(b);
  });

  it("should embed a recent timestamp in the second part", () => {
    const before = Date.now();
    const token = generateUiToken(SECRET);
    const after = Date.now();
    const ts = Number(token.split(".")[1]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("validateUiToken", () => {
  let usedTokens: Set<string>;

  beforeEach(() => {
    usedTokens = new Set();
  });

  it("should accept a freshly generated token", () => {
    const token = generateUiToken(SECRET);
    expect(validateUiToken(token, SECRET, usedTokens)).toBe(true);
  });

  it("should reject a reused token (single-use)", () => {
    const token = generateUiToken(SECRET);
    validateUiToken(token, SECRET, usedTokens); // first use
    expect(validateUiToken(token, SECRET, usedTokens)).toBe(false);
  });

  it("should reject a token validated with the wrong secret", () => {
    const token = generateUiToken(SECRET);
    expect(validateUiToken(token, "wrong-secret", usedTokens)).toBe(false);
  });

  it("should reject a tampered HMAC", () => {
    const token = generateUiToken(SECRET);
    const parts = token.split(".");
    parts[2] = "a".repeat(parts[2].length); // replace hmac with junk
    expect(validateUiToken(parts.join("."), SECRET, usedTokens)).toBe(false);
  });

  it("should reject a tampered nonce (HMAC mismatch)", () => {
    const token = generateUiToken(SECRET);
    const parts = token.split(".");
    parts[0] = "00".repeat(16); // replace random with zeros
    expect(validateUiToken(parts.join("."), SECRET, usedTokens)).toBe(false);
  });

  it("should reject a token with wrong number of parts", () => {
    expect(validateUiToken("onlyone", SECRET, usedTokens)).toBe(false);
    expect(validateUiToken("two.parts", SECRET, usedTokens)).toBe(false);
  });

  it("should reject an expired token (>60s old)", () => {
    vi.useFakeTimers();
    const token = generateUiToken(SECRET);
    vi.advanceTimersByTime(61_000);
    expect(validateUiToken(token, SECRET, usedTokens)).toBe(false);
    vi.useRealTimers();
  });

  it("should accept a token just within the 60s window", () => {
    vi.useFakeTimers();
    const token = generateUiToken(SECRET);
    vi.advanceTimersByTime(59_000);
    expect(validateUiToken(token, SECRET, usedTokens)).toBe(true);
    vi.useRealTimers();
  });

  it("should accept tokens from different requests concurrently", () => {
    const t1 = generateUiToken(SECRET);
    const t2 = generateUiToken(SECRET);
    expect(validateUiToken(t1, SECRET, usedTokens)).toBe(true);
    expect(validateUiToken(t2, SECRET, usedTokens)).toBe(true);
  });

  it("should return false for empty token string", () => {
    expect(validateUiToken("", SECRET, usedTokens)).toBe(false);
  });
});
