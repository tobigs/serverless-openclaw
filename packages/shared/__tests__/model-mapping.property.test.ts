import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { mapModelId } from "../src/model-mapping.js";

/**
 * Property-based tests for mapModelId().
 * Uses fast-check to verify universal properties across generated inputs.
 */

describe("mapModelId — property tests", () => {
  /**
   * Property 3: Model mapping idempotence
   * For any non-empty string, applying mapModelId() twice produces the same
   * result as applying it once: mapModelId(mapModelId(id)) === mapModelId(id).
   * This ensures IDs already in Bedrock format pass through unchanged,
   * and that mapped IDs are stable.
   *
   * Validates: Requirements 2.1, 2.5
   */
  it("Property 3: model mapping idempotence", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (id) => {
        expect(mapModelId(mapModelId(id))).toBe(mapModelId(id));
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Property 4: Anthropic model passthrough
   * For any model ID string that already starts with "anthropic.",
   * mapModelId() returns it unchanged. This validates the passthrough
   * behavior for IDs already in Bedrock format — when provider is
   * "anthropic", no mapping is applied, so the identity holds.
   *
   * Validates: Requirements 2.2
   */
  it("Property 4: anthropic model passthrough", () => {
    const anthropicModelArb = fc
      .string()
      .map((suffix) => `anthropic.${suffix}`);

    fc.assert(
      fc.property(anthropicModelArb, (id) => {
        expect(mapModelId(id)).toBe(id);
      }),
      { numRuns: 100 },
    );
  });
});
