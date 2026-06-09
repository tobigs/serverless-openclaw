export type AiProvider = "anthropic" | "bedrock";

export interface ProviderConfig {
  provider: AiProvider;
  openclawProvider: string;
  openclawApi: string;
  openclawAuth: string;
  defaultModel: string;
}

// OpenClaw 2026.6+ uses simplified model IDs (not raw AWS Bedrock ARN format).
// e.g. "claude-opus-4.6" instead of "eu.anthropic.claude-opus-4-6-v1"
export const BEDROCK_BASE_MODEL = "claude-sonnet-4.6";

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
 * Resolves the Bedrock model ID to use.
 * OpenClaw 2026.6+ uses simplified model IDs (no CRIS region prefix needed).
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
