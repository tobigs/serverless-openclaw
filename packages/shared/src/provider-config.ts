export type AiProvider = "anthropic" | "bedrock";

export interface ProviderConfig {
  provider: AiProvider;
  openclawProvider: string;
  openclawApi: string;
  openclawAuth: string;
  defaultModel: string;
}

// OpenClaw 2026.6+ with @openclaw/amazon-bedrock-provider handles CRIS routing internally.
// Use unprefixed model IDs — no eu./us./apac. prefix, no -v1 suffix.
// Format: "anthropic.claude-{name}-{major}-{minor}"
export const BEDROCK_BASE_MODEL = "anthropic.claude-sonnet-4-6";

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
 * Resolves the Bedrock model ID.
 * OpenClaw 2026.6+ with @openclaw/amazon-bedrock-provider handles CRIS internally.
 */
export function resolveBedrockModel(region?: string, aiModel?: string): string {
  return aiModel || BEDROCK_BASE_MODEL;
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
