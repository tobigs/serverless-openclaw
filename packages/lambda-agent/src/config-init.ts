import fs from "node:fs";
import path from "node:path";
import type { ConfigInitResult } from "./types.js";

interface InitConfigOptions {
  anthropicApiKey?: string;
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
  // - models.bedrockDiscovery.enabled: false — skip Bedrock ListFoundationModels
  //   (saves ~30s per cold start; we only use Anthropic direct API)
  const configPath = path.join(configDir, "openclaw.json");
  const config = {
    gateway: { mode: "local" },
    models: { bedrockDiscovery: { enabled: false } },
  };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");

  // Set API key via environment variable (OpenClaw reads from env)
  if (options?.anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = options.anthropicApiKey;
  }

  return { configDir, sessionsDir };
}
