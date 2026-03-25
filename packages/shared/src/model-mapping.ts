/**
 * Regex matching known Claude model ID patterns (e.g. claude-sonnet-4-20250514).
 * Used to suppress warnings for recognized model IDs.
 */
const KNOWN_MODEL_PATTERN = /^claude-[a-z]+-[\d]+-[\d\w-]+$/;

/**
 * Maps an Anthropic model ID to Bedrock format.
 *
 * - If `modelId` already starts with `"anthropic."`, it is returned unchanged.
 * - Otherwise, returns `"anthropic.${modelId}-v1:0"`.
 * - Logs a warning for IDs that don't match known Claude model patterns.
 */
export function mapModelId(modelId: string): string {
  if (modelId.startsWith("anthropic.")) {
    return modelId;
  }

  if (!KNOWN_MODEL_PATTERN.test(modelId)) {
    console.warn(
      `Unknown model ID pattern: "${modelId}". Mapping to "anthropic.${modelId}-v1:0" anyway.`,
    );
  }

  return `anthropic.${modelId}-v1:0`;
}
