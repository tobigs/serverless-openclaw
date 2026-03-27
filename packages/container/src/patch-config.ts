import { readFileSync, writeFileSync } from "node:fs";
import { GATEWAY_PORT } from "@serverless-openclaw/shared";
import type { AiProvider } from "@serverless-openclaw/shared";

interface PatchOptions {
  llmModel?: string;
  aiProvider?: AiProvider;
  awsRegion?: string;
  workspacePath?: string;
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

  if (options?.aiProvider === "bedrock") {
    // Configure LLM for Bedrock
    config.llm.provider = "amazon-bedrock";
    config.llm.api = "bedrock-converse-stream";
    delete config.llm.apiKey;

    // Enable Bedrock model discovery
    config.models = {
      ...config.models,
      bedrockDiscovery: { enabled: true, region: options.awsRegion },
    };

    // OpenClaw EC2/Fargate workaround — signal that credentials are available via SDK chain
    process.env.AWS_PROFILE = "default";
  } else {
    // Anthropic or unset — disable Bedrock discovery
    config.models = {
      ...config.models,
      bedrockDiscovery: { enabled: false },
    };
  }

  // Set agent workspace path so OpenClaw discovers skills and writes files there
  if (options?.workspacePath) {
    const agents = (config.agents ?? {}) as Record<string, unknown>;
    const defaults = (agents.defaults ?? {}) as Record<string, unknown>;
    defaults.workspace = options.workspacePath;
    agents.defaults = defaults;
    config.agents = agents;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

// CLI entry point: node patch-config.js <configPath>
if (process.argv[1]?.endsWith("patch-config.js")) {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("Usage: node patch-config.js <configPath>");
    process.exit(1);
  }
  const aiProvider = (process.env.AI_PROVIDER as AiProvider) ?? undefined;
  const llmModel = process.env.AI_MODEL ?? undefined;
  const awsRegion = process.env.AWS_REGION ?? undefined;
  const workspacePath = process.env.OPENCLAW_WORKSPACE ?? "/data/workspace";
  patchConfig(configPath, { aiProvider, llmModel, awsRegion, workspacePath });
  console.log("[patch-config] Config patched successfully");
}
