import fs from "node:fs";
import path from "node:path";
import type { LlmProvider } from "@serverless-openclaw/shared";
import type { ConfigInitResult } from "./types.js";

interface InitConfigOptions {
  anthropicApiKey?: string;
  provider?: LlmProvider;
  bedrockRegion?: string;
}

/**
 * Initialize OpenClaw config and directory structure in $HOME/.openclaw.
 * Sets HOME=/tmp in Lambda so OpenClaw reads from /tmp/.openclaw/.
 *
 * Idempotent — safe to call multiple times.
 */
export async function initConfig(
  options?: InitConfigOptions,
): Promise<ConfigInitResult> {
  const home = process.env.HOME ?? "/tmp";
  const configDir = path.join(home, ".openclaw");
  const sessionsDir = path.join(configDir, "agents", "default", "sessions");

  // Create directory structure
  fs.mkdirSync(sessionsDir, { recursive: true });

  // Write minimal config optimized for Lambda execution:
  // - gateway.mode: "local" — no WS server needed
  // - models.bedrockDiscovery: configured based on provider
  const configPath = path.join(configDir, "openclaw.json");
  const isBedrock = options?.provider === "bedrock";

  const bedrockDiscovery: Record<string, unknown> = {
    enabled: isBedrock,
  };
  if (isBedrock && options?.bedrockRegion) {
    bedrockDiscovery.region = options.bedrockRegion;
  }

  // In eu-central-1, all Anthropic models are INFERENCE_PROFILE type only —
  // bedrockDiscovery (ListFoundationModels) registers their foundation model IDs,
  // but actual invocation requires the eu.anthropic.* cross-region inference profile
  // IDs which don't appear in ListFoundationModels. We declare them explicitly here
  // so they are merged into the amazon-bedrock provider registry at startup.
  const bedrockExplicitModels = isBedrock
    ? {
        providers: {
          "amazon-bedrock": {
            auth: "aws-sdk",
            api: "bedrock-converse-stream",
            baseUrl: `https://bedrock-runtime.${options?.bedrockRegion ?? "eu-central-1"}.amazonaws.com`,
            models: [
              {
                id: "eu.anthropic.claude-3-7-sonnet-20250219-v1:0",
                name: "Claude 3.7 Sonnet (EU)",
                api: "bedrock-converse-stream",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                contextWindow: 200000,
                maxTokens: 128000,
              },
              {
                id: "eu.anthropic.claude-3-5-sonnet-20240620-v1:0",
                name: "Claude 3.5 Sonnet (EU)",
                api: "bedrock-converse-stream",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      }
    : undefined;

  const config = {
    gateway: { mode: "local" },
    models: { bedrockDiscovery, ...bedrockExplicitModels },
  };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");

  // Set API key via environment variable (OpenClaw reads from env)
  // Skip when using Bedrock — IAM credentials are used instead
  if (!isBedrock && options?.anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = options.anthropicApiKey;
  }

  return { configDir, sessionsDir };
}
