import { readFileSync, writeFileSync } from "node:fs";
import { GATEWAY_PORT, type LlmProvider } from "@serverless-openclaw/shared";

interface PatchOptions {
  llmModel?: string;
  provider?: LlmProvider;
}

export function patchConfig(configPath: string, options?: PatchOptions): void {
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as Record<string, Record<string, unknown>>;

  // Set gateway port
  config.gateway = { ...config.gateway, port: GATEWAY_PORT };

  // Remove auth secrets from config (API keys delivered via env vars only)
  if (config.auth) {
    delete config.auth.token;
  }

  // Remove Telegram section entirely (webhook-only, configured via env)
  delete config.telegram;

  // Remove LLM secrets, optionally override model
  config.llm = { ...config.llm };
  delete config.llm.apiKey;
  if (options?.llmModel) {
    config.llm.model = options.llmModel;
  }

  // Enable Bedrock discovery when provider is "bedrock"
  if (options?.provider === "bedrock") {
    config.models = {
      ...config.models,
      bedrockDiscovery: { enabled: true },
    };
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}
