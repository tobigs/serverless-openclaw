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
