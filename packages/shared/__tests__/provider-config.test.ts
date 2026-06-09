import { describe, it, expect } from "vitest";
import {
  resolveBedrockModel,
  resolveProviderConfig,
  BEDROCK_BASE_MODEL,
} from "../src/provider-config.js";

describe("resolveBedrockModel", () => {
  it("returns base model when no args provided", () => {
    expect(resolveBedrockModel()).toBe(BEDROCK_BASE_MODEL);
  });

  it("prepends CRIS prefix for known regions", () => {
    expect(resolveBedrockModel("eu-central-1")).toBe(`eu.${BEDROCK_BASE_MODEL}`);
    expect(resolveBedrockModel("us-east-1")).toBe(`us.${BEDROCK_BASE_MODEL}`);
    expect(resolveBedrockModel("ap-northeast-1")).toBe(`apac.${BEDROCK_BASE_MODEL}`);
  });

  it("returns base model for unknown region (no CRIS prefix)", () => {
    expect(resolveBedrockModel("sa-east-1")).toBe(BEDROCK_BASE_MODEL);
  });

  it("returns AI_MODEL override as-is", () => {
    expect(resolveBedrockModel("eu-central-1", "my-custom-model")).toBe("my-custom-model");
  });

  it("ignores empty string AI_MODEL and uses region resolution", () => {
    expect(resolveBedrockModel("eu-central-1", "")).toBe(`eu.${BEDROCK_BASE_MODEL}`);
  });
});

describe("resolveProviderConfig", () => {
  it("resolves bedrock with simplified model ID", () => {
    const config = resolveProviderConfig({
      AI_PROVIDER: "bedrock",
      AWS_REGION: "eu-central-1",
    });
    expect(config.defaultModel).toBe("eu.anthropic.claude-sonnet-4-6");
    expect(config.openclawProvider).toBe("amazon-bedrock");
    expect(config.openclawApi).toBe("bedrock-converse-stream");
  });

  it("uses AI_MODEL override for bedrock", () => {
    const config = resolveProviderConfig({
      AI_PROVIDER: "bedrock",
      AWS_REGION: "eu-central-1",
      AI_MODEL: "custom-model-id",
    });
    expect(config.defaultModel).toBe("custom-model-id");
  });

  it("resolves anthropic defaults correctly", () => {
    const config = resolveProviderConfig({ AI_PROVIDER: "anthropic" });
    expect(config.openclawProvider).toBe("anthropic");
    expect(config.openclawApi).toBe("anthropic");
    expect(config.defaultModel).toBe("claude-sonnet-4-20250514");
  });

  it("applies AI_MODEL override for anthropic", () => {
    const config = resolveProviderConfig({
      AI_PROVIDER: "anthropic",
      AI_MODEL: "claude-opus-4-20250514",
    });
    expect(config.defaultModel).toBe("claude-opus-4-20250514");
  });

  it("defaults to anthropic when AI_PROVIDER is not set", () => {
    const config = resolveProviderConfig({});
    expect(config.provider).toBe("anthropic");
  });

  it("does not expose bedrockDiscovery on the config object", () => {
    const config = resolveProviderConfig({ AI_PROVIDER: "bedrock" });
    expect(config).not.toHaveProperty("bedrockDiscovery");
  });
});
