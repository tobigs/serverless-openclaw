import { describe, it, expect } from "vitest";
import {
  resolveBedrockModel,
  resolveProviderConfig,
  isOnDemandBedrockModel,
  isGlobalInferenceModel,
  BEDROCK_BASE_MODEL,
  BEDROCK_ON_DEMAND_MODELS,
  CLAUDE_SONNET_5_MODEL,
} from "../src/provider-config.js";

describe("resolveBedrockModel", () => {
  it("returns eu-prefixed model for eu-central-1", () => {
    expect(resolveBedrockModel("eu-central-1")).toBe("eu.anthropic.claude-sonnet-4-6");
  });

  it("returns us-prefixed model for us-east-1", () => {
    expect(resolveBedrockModel("us-east-1")).toBe("us.anthropic.claude-sonnet-4-6");
  });

  it("returns ap-prefixed model for ap-northeast-1", () => {
    expect(resolveBedrockModel("ap-northeast-1")).toBe("ap.anthropic.claude-sonnet-4-6");
  });

  it("falls back to BEDROCK_BASE_MODEL for unknown region", () => {
    expect(resolveBedrockModel("sa-east-1")).toBe(BEDROCK_BASE_MODEL);
    expect(resolveBedrockModel()).toBe(BEDROCK_BASE_MODEL);
  });

  it("returns AI_MODEL override as-is", () => {
    expect(resolveBedrockModel("eu-central-1", "my-custom-model")).toBe("my-custom-model");
  });

  it("ignores empty string AI_MODEL and returns region-prefixed model", () => {
    expect(resolveBedrockModel("eu-central-1", "")).toBe("eu.anthropic.claude-sonnet-4-6");
  });
});

describe("resolveProviderConfig", () => {
  it("resolves bedrock with CRIS-prefixed model ID for eu-central-1", () => {
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

  it("resolves DeepSeek V3.2 as the AI_MODEL override in eu-north-1", () => {
    const config = resolveProviderConfig({
      AI_PROVIDER: "bedrock",
      AWS_REGION: "eu-north-1",
      AI_MODEL: "deepseek.v3.2",
    });
    expect(config.defaultModel).toBe("deepseek.v3.2");
    expect(config.openclawProvider).toBe("amazon-bedrock");
  });

  it("resolves Kimi K2.5 as the AI_MODEL override in eu-north-1", () => {
    const config = resolveProviderConfig({
      AI_PROVIDER: "bedrock",
      AWS_REGION: "eu-north-1",
      AI_MODEL: "moonshotai.kimi-k2.5",
    });
    expect(config.defaultModel).toBe("moonshotai.kimi-k2.5");
  });

  it("resolves GLM 4.7 as the AI_MODEL override in eu-north-1", () => {
    const config = resolveProviderConfig({
      AI_PROVIDER: "bedrock",
      AWS_REGION: "eu-north-1",
      AI_MODEL: "zai.glm-4.7",
    });
    expect(config.defaultModel).toBe("zai.glm-4.7");
  });
});

describe("isOnDemandBedrockModel", () => {
  it("identifies DeepSeek, Kimi (Moonshot), and GLM (Z.AI) as on-demand", () => {
    expect(isOnDemandBedrockModel("deepseek.v3.2")).toBe(true);
    expect(isOnDemandBedrockModel("moonshotai.kimi-k2.5")).toBe(true);
    expect(isOnDemandBedrockModel("zai.glm-4.7")).toBe(true);
    expect(isOnDemandBedrockModel("zai.glm-5")).toBe(true);
  });

  it("does not classify Anthropic CRIS models as on-demand", () => {
    expect(isOnDemandBedrockModel("eu.anthropic.claude-sonnet-4-6")).toBe(false);
    expect(isOnDemandBedrockModel("anthropic.claude-opus-4-8")).toBe(false);
  });
});

describe("BEDROCK_ON_DEMAND_MODELS", () => {
  it("includes catalog entries for DeepSeek, Kimi, and GLM", () => {
    expect(BEDROCK_ON_DEMAND_MODELS["deepseek-v3.2"].id).toBe("deepseek.v3.2");
    expect(BEDROCK_ON_DEMAND_MODELS["kimi-k2.5"].id).toBe("moonshotai.kimi-k2.5");
    expect(BEDROCK_ON_DEMAND_MODELS["glm-4.7"].id).toBe("zai.glm-4.7");
    expect(BEDROCK_ON_DEMAND_MODELS["glm-5"].id).toBe("zai.glm-5");
  });
});

describe("Claude Sonnet 5 (global inference only, no eu./us./ap. CRIS profile)", () => {
  it("exposes the global-prefixed model ID", () => {
    expect(CLAUDE_SONNET_5_MODEL).toBe("global.anthropic.claude-sonnet-5");
  });

  it("resolves as the AI_MODEL override regardless of AWS_REGION", () => {
    const config = resolveProviderConfig({
      AI_PROVIDER: "bedrock",
      AWS_REGION: "eu-central-1",
      AI_MODEL: "global.anthropic.claude-sonnet-5",
    });
    expect(config.defaultModel).toBe("global.anthropic.claude-sonnet-5");
  });

  it("isGlobalInferenceModel identifies the global. prefix", () => {
    expect(isGlobalInferenceModel("global.anthropic.claude-sonnet-5")).toBe(true);
    expect(isGlobalInferenceModel("eu.anthropic.claude-sonnet-4-6")).toBe(false);
    expect(isGlobalInferenceModel("deepseek.v3.2")).toBe(false);
  });

  it("is not classified as an on-demand model (still Anthropic, gets thinking params)", () => {
    expect(isOnDemandBedrockModel("global.anthropic.claude-sonnet-5")).toBe(false);
  });
});
