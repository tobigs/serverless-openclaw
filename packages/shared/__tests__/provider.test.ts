import { describe, it, expect, afterEach } from "vitest";
import { resolveProvider } from "../src/provider.js";

describe("resolveProvider", () => {
  const originalEnv = process.env.LLM_PROVIDER;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LLM_PROVIDER;
    } else {
      process.env.LLM_PROVIDER = originalEnv;
    }
  });

  it('returns "anthropic" when LLM_PROVIDER is unset', () => {
    delete process.env.LLM_PROVIDER;
    expect(resolveProvider()).toBe("anthropic");
  });

  it('returns "anthropic" when LLM_PROVIDER is empty string', () => {
    process.env.LLM_PROVIDER = "";
    expect(resolveProvider()).toBe("anthropic");
  });

  it('returns "bedrock" when LLM_PROVIDER is "bedrock"', () => {
    process.env.LLM_PROVIDER = "bedrock";
    expect(resolveProvider()).toBe("bedrock");
  });

  it('is case-insensitive: "BEDROCK" → "bedrock"', () => {
    process.env.LLM_PROVIDER = "BEDROCK";
    expect(resolveProvider()).toBe("bedrock");
  });

  it('is case-insensitive: "Anthropic" → "anthropic"', () => {
    process.env.LLM_PROVIDER = "Anthropic";
    expect(resolveProvider()).toBe("anthropic");
  });

  it('throws for invalid value "openai"', () => {
    process.env.LLM_PROVIDER = "openai";
    expect(() => resolveProvider()).toThrow(
      'Invalid LLM_PROVIDER value: "openai". Must be "anthropic" or "bedrock".',
    );
  });
});
