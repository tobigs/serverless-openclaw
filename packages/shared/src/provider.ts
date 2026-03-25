export type LlmProvider = "anthropic" | "bedrock";

const VALID_PROVIDERS: readonly LlmProvider[] = ["anthropic", "bedrock"] as const;

/**
 * Reads LLM_PROVIDER env var, validates, and returns normalized provider.
 * Defaults to "anthropic" when unset or empty.
 * Throws on invalid values.
 */
export function resolveProvider(): LlmProvider {
  const raw = process.env.LLM_PROVIDER;
  if (!raw) {
    return "anthropic";
  }

  const normalized = raw.toLowerCase();
  if (VALID_PROVIDERS.includes(normalized as LlmProvider)) {
    return normalized as LlmProvider;
  }

  throw new Error(
    `Invalid LLM_PROVIDER value: "${raw}". Must be "anthropic" or "bedrock".`,
  );
}
