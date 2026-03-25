import { describe, it, expect } from "vitest";
import { mapModelId } from "../src/model-mapping.js";

describe("mapModelId", () => {
  it('maps "claude-sonnet-4-20250514" to Bedrock format', () => {
    expect(mapModelId("claude-sonnet-4-20250514")).toBe(
      "anthropic.claude-sonnet-4-20250514-v1:0",
    );
  });

  it('maps "claude-haiku-3-5-20241022" to Bedrock format', () => {
    expect(mapModelId("claude-haiku-3-5-20241022")).toBe(
      "anthropic.claude-haiku-3-5-20241022-v1:0",
    );
  });

  it("passes through an already-Bedrock ID unchanged", () => {
    expect(mapModelId("anthropic.claude-sonnet-4-20250514-v1:0")).toBe(
      "anthropic.claude-sonnet-4-20250514-v1:0",
    );
  });
});
