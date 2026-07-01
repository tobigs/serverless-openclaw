export type AiProvider = "anthropic" | "bedrock";

export interface ProviderConfig {
  provider: AiProvider;
  openclawProvider: string;
  openclawApi: string;
  openclawAuth: string;
  defaultModel: string;
}

// Claude 4.x on Bedrock requires cross-region inference profiles (CRIS).
// Direct foundation model invocation is rejected — must use the regional prefix.
// eu-central-1 → eu.anthropic.claude-*
// us-east-1/us-west-2 → us.anthropic.claude-*
export const BEDROCK_BASE_MODEL = "eu.anthropic.claude-sonnet-4-6";

const REGION_CRIS_PREFIX: Record<string, string> = {
  "eu-central-1": "eu",
  "eu-west-1": "eu",
  "eu-west-2": "eu",
  "eu-west-3": "eu",
  "eu-north-1": "eu",
  "eu-south-1": "eu",
  "us-east-1": "us",
  "us-east-2": "us",
  "us-west-2": "us",
  "ap-northeast-1": "ap",
  "ap-northeast-2": "ap",
  "ap-southeast-1": "ap",
  "ap-southeast-2": "ap",
  "ap-south-1": "ap",
};

// Non-Anthropic Bedrock models are invoked ON_DEMAND with a direct model ID —
// no CRIS region prefix. Availability varies by region (verified via
// `aws bedrock list-foundation-models`); eu-north-1 carries all three below.
export const BEDROCK_ON_DEMAND_MODELS: Record<string, { id: string; name: string }> = {
  "deepseek-v3.2": { id: "deepseek.v3.2", name: "DeepSeek V3.2" },
  "kimi-k2.5": { id: "moonshotai.kimi-k2.5", name: "Kimi K2.5" },
  "glm-4.7": { id: "zai.glm-4.7", name: "GLM 4.7" },
  "glm-5": { id: "zai.glm-5", name: "GLM 5" },
};

/** True for Bedrock model IDs that are invoked directly (ON_DEMAND) and take no CRIS prefix. */
export function isOnDemandBedrockModel(modelId: string): boolean {
  return (
    modelId.startsWith("deepseek.") ||
    modelId.startsWith("moonshotai.") ||
    modelId.startsWith("zai.") ||
    modelId.startsWith("qwen.") ||
    modelId.startsWith("minimax.") ||
    modelId.startsWith("openai.gpt-oss")
  );
}

// Claude Sonnet 5 (launched 2026-06-30) has no In-Region or Geo (eu./us./ap.) inference
// profile — only Global cross-region inference is available (verified via
// `aws bedrock get-inference-profile --inference-profile-identifier global.anthropic.claude-sonnet-5`).
// It is still an Anthropic model (gets "thinking: adaptive" params) but uses the "global."
// prefix instead of a region-derived CRIS prefix.
export const CLAUDE_SONNET_5_MODEL = "global.anthropic.claude-sonnet-5";

/** True for Bedrock model IDs that use the "global." cross-region prefix instead of eu./us./ap. */
export function isGlobalInferenceModel(modelId: string): boolean {
  return modelId.startsWith("global.");
}

export const PROVIDER_DEFAULTS = {
  anthropic: {
    openclawProvider: "anthropic",
    openclawApi: "anthropic",
    openclawAuth: "api-key",
    defaultModel: "claude-sonnet-4-20250514",
  },
  bedrock: {
    openclawProvider: "amazon-bedrock",
    openclawApi: "bedrock-converse-stream",
    openclawAuth: "aws-sdk",
  },
} as const;

const VALID_PROVIDERS: readonly string[] = ["anthropic", "bedrock"];

export function validateProvider(value: string): asserts value is AiProvider {
  if (!VALID_PROVIDERS.includes(value)) {
    throw new Error(`Unsupported AI_PROVIDER: '${value}'. Valid values: anthropic, bedrock`);
  }
}

/**
 * Resolves the Bedrock model ID with the correct CRIS prefix for the region.
 * Claude 4.x requires cross-region inference profiles — direct invocation is rejected.
 */
export function resolveBedrockModel(region?: string, aiModel?: string): string {
  if (aiModel) return aiModel;
  const base = "anthropic.claude-sonnet-4-6";
  const prefix = region ? REGION_CRIS_PREFIX[region] : undefined;
  return prefix ? `${prefix}.${base}` : BEDROCK_BASE_MODEL;
}

export function resolveModel(provider: "anthropic", aiModel?: string): string {
  return aiModel || PROVIDER_DEFAULTS[provider].defaultModel;
}

export function resolveProviderConfig(env?: {
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AWS_REGION?: string;
}): ProviderConfig {
  const resolved = env ?? process.env;
  const raw = resolved.AI_PROVIDER ?? "anthropic";
  validateProvider(raw);

  const defaults = PROVIDER_DEFAULTS[raw];

  const defaultModel =
    raw === "bedrock"
      ? resolveBedrockModel(resolved.AWS_REGION, resolved.AI_MODEL)
      : resolveModel(raw, resolved.AI_MODEL);

  return {
    provider: raw,
    openclawProvider: defaults.openclawProvider,
    openclawApi: defaults.openclawApi,
    openclawAuth: defaults.openclawAuth,
    defaultModel,
  };
}
