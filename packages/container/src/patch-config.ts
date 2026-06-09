import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { GATEWAY_PORT, resolveProviderConfig } from "@serverless-openclaw/shared";
import type { AiProvider } from "@serverless-openclaw/shared";

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

/**
 * Restore openclaw.json from S3 before patching.
 * Allows OpenClaw's self-managed config (agents, skills, tools, mcp) to persist
 * across cold starts. Falls back silently if no config exists in S3 yet.
 */
async function restoreConfigFromS3(configPath: string): Promise<void> {
  const bucket = process.env.DATA_BUCKET;
  const userId = process.env.USER_ID;
  if (!bucket || !userId) return;

  const s3Key = `openclaw-home/${userId}/openclaw.json`;
  try {
    const client = new S3Client({});
    const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
    if (resp.Body) {
      const bytes = await resp.Body.transformToByteArray();
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, bytes);
      console.log("[patch-config] Restored openclaw.json from S3");
    }
  } catch {
    // First launch — no config in S3 yet, proceed with existing file
  }
}

export function patchConfig(configPath: string, options?: PatchOptions): void {
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as Record<string, Record<string, unknown>>;

  // ── Mandatory overrides (always applied on top of persisted config) ──

  // Gateway port must always be 18789
  config.gateway = { ...config.gateway, port: GATEWAY_PORT };

  // Allow the agent to self-restart, and authorize the container owner
  const ownerId = process.env.USER_ID;
  config.commands = {
    ...config.commands,
    restart: true,
    ...(ownerId ? { ownerAllowFrom: [ownerId] } : {}),
  };

  // Remove secrets — API keys delivered via env vars only
  if (config.auth) delete config.auth.token;
  delete config.llm;
  // Strip all Telegram config — webhook-only, token managed by Lambda layer.
  // Also strip channels.telegram in case OpenClaw wrote it to persisted config.
  delete config.telegram;
  if (config.channels) delete (config.channels as Record<string, unknown>).telegram;
  // Strip any native telegram plugin entry from persisted config
  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  const entries = (plugins.entries ?? {}) as Record<string, unknown>;
  delete entries.telegram;
  plugins.entries = entries;
  config.plugins = plugins;

  // Strip keys that are invalid in 2026.6 schema or should never be persisted.
  const models = config.models as Record<string, unknown> | undefined;
  if (models) {
    delete models.bedrockDiscovery; // removed from 2026.6 schema
    delete models.providers; // written fresh at every boot — stale copy causes wrong models
    if (Object.keys(models).length === 0) delete config.models;
  }

  // Set model and workspace
  const agents = (config.agents ?? {}) as Record<string, unknown>;
  const defaults = (agents.defaults ?? {}) as Record<string, unknown>;

  // Strip named agent keys written by older OpenClaw versions (e.g. agents.coach).
  // In 2026.6, named agents live in agents.list — top-level keys cause "agents: Invalid input".
  for (const key of Object.keys(agents)) {
    if (key !== "defaults" && key !== "list") delete agents[key];
  }

  // Determine the active model ID — persisted config wins over env seed.
  // This allows /model and /think commands to survive cold starts.
  const persistedPrimary = (defaults.model as Record<string, unknown> | undefined)?.primary as
    | string
    | undefined;
  let activeModelId: string | undefined;

  if (persistedPrimary) {
    // Keep OpenClaw's own choice (e.g. set via /model command)
    activeModelId = persistedPrimary.split("/").slice(1).join("/");
  } else if (options?.aiProvider || options?.llmModel) {
    // First boot or no persisted model — seed from env
    const providerConfig = resolveProviderConfig({
      AI_PROVIDER: options.aiProvider,
      AI_MODEL: options.llmModel,
      AWS_REGION: options.awsRegion,
    });
    activeModelId = providerConfig.defaultModel;
    defaults.model = {
      primary: `${providerConfig.openclawProvider}/${activeModelId}`,
    };
  }

  // Always register the Bedrock provider entry explicitly so OpenClaw doesn't need to
  // run async discovery at inference time. Uses the active model ID (persisted or seeded).
  // Additional models are registered in the catalog for /model switching.
  if (options?.aiProvider === "bedrock" && activeModelId) {
    const region = options.awsRegion ?? "us-east-1";
    const crisPrefix = region.startsWith("eu") ? "eu" : region.startsWith("ap") ? "apac" : "us";
    const modelsSection = (config.models ?? {}) as Record<string, unknown>;
    const providers = (modelsSection.providers ?? {}) as Record<string, unknown>;

    // Build the model catalog — always include the active model plus any known alternates.
    // The active model must be first so OpenClaw picks it as default.
    const opusModel = `${crisPrefix}.anthropic.claude-opus-4-8`;
    const sonnetModel = `${crisPrefix}.anthropic.claude-sonnet-4-6`;
    const catalogModels: Array<{
      id: string;
      name: string;
      contextWindow: number;
      maxTokens: number;
    }> = [];

    // Active model first
    catalogModels.push({
      id: activeModelId,
      name: activeModelId,
      contextWindow: 1000000,
      maxTokens: 8192,
    });

    // Add known alternates (skip if same as active)
    for (const alternate of [sonnetModel, opusModel]) {
      if (alternate !== activeModelId) {
        catalogModels.push({
          id: alternate,
          name: alternate,
          contextWindow: 200000,
          maxTokens: 8192,
        });
      }
    }

    providers["amazon-bedrock"] = {
      baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
      api: "bedrock-converse-stream",
      auth: "aws-sdk",
      models: catalogModels,
    };
    modelsSection.providers = providers;
    config.models = modelsSection;
  }

  if (options?.workspacePath) {
    defaults.workspace = options.workspacePath;
  }

  // Always apply thinking level from env — /think is session-only and doesn't persist.
  // Valid: off|minimal|low|medium|high|xhigh|adaptive|max
  // adaptive = OpenClaw auto-selects depth per message; falls back to medium for non-adaptive models.
  if (process.env.THINKING_LEVEL) {
    defaults.thinkingDefault = process.env.THINKING_LEVEL;
  }

  // Seed agents.list from EXTRA_TELEGRAM_BOTS — each extra bot gets a named agent entry
  // with its own model and thinkingDefault if specified in agentProfile.
  // agents.list is the correct 2026.6 schema location; top-level agents.{id} keys are invalid.
  try {
    const extraBots = JSON.parse(process.env.EXTRA_TELEGRAM_BOTS ?? "[]") as Array<{
      id: string;
      agentProfile?: { model?: string; thinking?: string; systemPrompt?: string };
    }>;
    if (extraBots.length > 0) {
      const existingList = Array.isArray(agents.list) ? (agents.list as unknown[]) : [];
      const newList: unknown[] = [];
      for (const bot of extraBots) {
        const existing = existingList.find(
          (e) =>
            typeof e === "object" && e !== null && (e as Record<string, unknown>).id === bot.id,
        );
        if (existing) {
          newList.push(existing); // keep persisted entry (e.g. /model changes)
        } else {
          // Seed from agentProfile — only on first boot
          const entry: Record<string, unknown> = { id: bot.id };
          if (bot.agentProfile?.model) {
            entry.model = { primary: `amazon-bedrock/${bot.agentProfile.model}` };
          }
          entry.thinkingDefault =
            bot.agentProfile?.thinking ?? process.env.THINKING_LEVEL ?? "adaptive";
          // systemPrompt is not a valid AgentEntrySchema field — belongs in workspace files
          newList.push(entry);
        }
      }
      agents.list = newList;
    }
  } catch {
    /* non-fatal */
  }

  agents.defaults = defaults;
  config.agents = agents;

  // ── MCP: register Google Workspace if credentials are available ──
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

  // Restore persisted config from S3 before patching
  restoreConfigFromS3(configPath)
    .then(() => {
      patchConfig(configPath, { aiProvider, llmModel, awsRegion, workspacePath });
      console.log("[patch-config] Config patched successfully");
    })
    .catch((err) => {
      console.error("[patch-config] Fatal error:", err);
      process.exit(1);
    });
}
