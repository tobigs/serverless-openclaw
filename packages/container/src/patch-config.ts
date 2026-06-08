import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GATEWAY_PORT, resolveProviderConfig } from "@serverless-openclaw/shared";
import type { AiProvider, ExtraTelegramBot } from "@serverless-openclaw/shared";

interface PatchOptions {
  llmModel?: string;
  aiProvider?: AiProvider;
  awsRegion?: string;
  workspacePath?: string;
}

function readTrimmed(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const v = readFileSync(path, "utf-8").trim();
  return v || undefined;
}

export function patchConfig(configPath: string, options?: PatchOptions): void {
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as Record<string, Record<string, unknown>>;

  // Set gateway port
  config.gateway = { ...config.gateway, port: GATEWAY_PORT };

  // Allow the agent to self-restart via the gateway restart command
  config.commands = { ...config.commands, restart: true };

  // Remove auth secrets from config (API keys delivered via env vars only)
  if (config.auth) {
    delete config.auth.token;
  }

  // Remove legacy llm section — not a valid OpenClaw v2026+ key, may contain secrets
  delete config.llm;

  // Remove Telegram section entirely (webhook-only, configured via env)
  delete config.telegram;

  // Disable Bedrock model discovery — model is set explicitly, discovery scans ~56s
  config.models = {
    ...config.models,
    bedrockDiscovery: { enabled: false },
  };

  if (options?.aiProvider === "bedrock") {
    // Signal that AWS credentials are available via SDK chain (EC2/Fargate IAM role)
    process.env.AWS_PROFILE = "default";
  }

  // Set agent defaults (model and workspace)
  const agents = (config.agents ?? {}) as Record<string, unknown>;
  const defaults = (agents.defaults ?? {}) as Record<string, unknown>;

  // Set model in OpenClaw's provider/model format (e.g. "amazon-bedrock/eu.anthropic...")
  if (options?.aiProvider || options?.llmModel) {
    const providerConfig = resolveProviderConfig({
      AI_PROVIDER: options.aiProvider,
      AI_MODEL: options.llmModel,
      AWS_REGION: options.awsRegion,
    });
    defaults.model = {
      primary: `${providerConfig.openclawProvider}/${providerConfig.defaultModel}`,
    };
  }

  if (options?.workspacePath) {
    defaults.workspace = options.workspacePath;
  }

  defaults.thinking = "medium";

  agents.defaults = defaults;
  config.agents = agents;

  // Register extra Telegram bots as additional OpenClaw plugin entries.
  // Each bot gets its own plugin key so OpenClaw routes messages to the right session.
  const extraBots: ExtraTelegramBot[] = (() => {
    try {
      return JSON.parse(process.env.EXTRA_TELEGRAM_BOTS ?? "[]") as ExtraTelegramBot[];
    } catch {
      return [];
    }
  })();

  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  const entries = (plugins.entries ?? {}) as Record<string, unknown>;
  for (const bot of extraBots) {
    const botToken = process.env[`TELEGRAM_BOT_TOKEN_${bot.id.toUpperCase()}`];
    if (!botToken) continue;
    entries[`telegram-${bot.id}`] = {
      enabled: true,
      token: botToken,
      ...(bot.agentProfile ? { agentProfile: bot.agentProfile } : {}),
    };
  }
  plugins.entries = entries;
  config.plugins = plugins;

  // Strip any `mcp` key written by OpenClaw into the persisted config — the
  // current OpenClaw version rejects it as unrecognized and exits at startup.
  // Only re-add it when ENABLE_MCP=true (future upgrade path).
  delete config.mcp;

  if (process.env.ENABLE_MCP === "true") {
    const credsDir = join(homedir(), ".google_workspace_mcp", "credentials");
    const clientId = readTrimmed(join(credsDir, "client_id.txt"));
    const clientSecret = readTrimmed(join(credsDir, "client_secret.txt"));
    if (clientId && clientSecret) {
      const mcp = (config.mcp ?? {}) as Record<string, unknown>;
      const servers = (mcp.servers ?? {}) as Record<string, unknown>;
      servers["google-workspace"] = {
        command: "uvx",
        args: ["workspace-mcp", "--tools", "gmail", "calendar", "tasks"],
        env: {
          GOOGLE_OAUTH_CLIENT_ID: clientId,
          GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
          OAUTHLIB_INSECURE_TRANSPORT: "1",
        },
      };
      mcp.servers = servers;
      config.mcp = mcp;
    }
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
