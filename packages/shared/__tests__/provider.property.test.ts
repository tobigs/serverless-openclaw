import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { resolveProvider } from "../src/provider.js";

/**
 * Property-based tests for resolveProvider().
 * Uses fast-check to verify universal properties across generated inputs.
 */

const VALID_PROVIDERS = ["anthropic", "bedrock"] as const;

/** Generate a random case variant of a given string */
function randomCaseVariant(base: string): fc.Arbitrary<string> {
  return fc
    .array(fc.boolean(), { minLength: base.length, maxLength: base.length })
    .map((flags) =>
      base
        .split("")
        .map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join(""),
    );
}

describe("resolveProvider — property tests", () => {
  const originalEnv = process.env.LLM_PROVIDER;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LLM_PROVIDER;
    } else {
      process.env.LLM_PROVIDER = originalEnv;
    }
  });

  /**
   * Property 1: Case-insensitive provider resolution
   * For any case variant of "anthropic" or "bedrock", resolveProvider()
   * returns the correct lowercase value.
   *
   * Validates: Requirements 1.1
   */
  it("Property 1: case-insensitive provider resolution", () => {
    const providerArb = fc.oneof(
      randomCaseVariant("anthropic").map(
        (v) => [v, "anthropic"] as [string, string],
      ),
      randomCaseVariant("bedrock").map(
        (v) => [v, "bedrock"] as [string, string],
      ),
    );

    fc.assert(
      fc.property(providerArb, ([variant, expected]) => {
        process.env.LLM_PROVIDER = variant;
        expect(resolveProvider()).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });


  /**
   * Property 2: Invalid provider rejection
   * For any non-empty string that is not a case-insensitive match for
   * "anthropic" or "bedrock", resolveProvider() throws an Error.
   *
   * Validates: Requirements 1.3
   */
  it("Property 2: invalid provider rejection", () => {
    const invalidProviderArb = fc
      .string({ minLength: 1 })
      .filter(
        (s) =>
          !VALID_PROVIDERS.includes(
            s.toLowerCase() as (typeof VALID_PROVIDERS)[number],
          ),
      );

    fc.assert(
      fc.property(invalidProviderArb, (invalid) => {
        process.env.LLM_PROVIDER = invalid;
        expect(() => resolveProvider()).toThrow(Error);
      }),
      { numRuns: 100 },
    );
  });
});
