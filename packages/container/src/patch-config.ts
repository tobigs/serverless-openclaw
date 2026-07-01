import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  GATEWAY_PORT,
  resolveProviderConfig,
  isOnDemandBedrockModel,
  CLAUDE_SONNET_5_MODEL,
} from "@serverless-openclaw/shared";
import type { AiProvider } from "@serverless-openclaw/shared";

interface PatchOptions {
  llmModel?: string;
  aiProvider?: AiProvider;
  awsRegion?: string;
  /**
   * Region for the Bedrock runtime endpoint, independent of awsRegion (the infra's own
   * deploy region). Lets Bedrock inference calls target a region where a specific model
   * is available without moving/redeploying the rest of the stack. Defaults to awsRegion.
   */
  bedrockRegion?: string;
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
  // Uses bedrockRegion (independent of awsRegion) so Bedrock calls can target a region
  // where a specific model is available without moving the rest of the stack.
  if (options?.aiProvider === "bedrock" && activeModelId) {
    const region = options.bedrockRegion ?? options.awsRegion ?? "us-east-1";
    const crisPrefix = region.startsWith("eu") ? "eu" : region.startsWith("ap") ? "apac" : "us";
    const modelsSection = (config.models ?? {}) as Record<string, unknown>;
    const providers = (modelsSection.providers ?? {}) as Record<string, unknown>;

    // Build the model catalog — always include the active model plus any known alternates.
    // The active model must be first so OpenClaw picks it as default.
    const opusModel = `${crisPrefix}.anthropic.claude-opus-4-8`;
    const sonnetModel = `${crisPrefix}.anthropic.claude-sonnet-4-6`;
    // Claude Sonnet 5 has no eu./us./ap. CRIS profile — only "global." cross-region
    // inference is available, so it's listed separately from the region-derived prefix.
    const sonnet5Model = CLAUDE_SONNET_5_MODEL;
    // Non-Anthropic models are invoked ON_DEMAND with a direct model ID (no CRIS prefix).
    // Availability varies by region — these are confirmed in eu-north-1.
    const onDemandAlternates = ["deepseek.v3.2", "moonshotai.kimi-k2.5", "zai.glm-4.7"];
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

    // Add known alternates (skip if same as active).
    // Claude alternates only make sense when the active model is itself an Anthropic
    // CRIS model — mixing them in with a non-Anthropic default is misleading, since the
    // CRIS prefix computed above may not match the active model's own region logic.
    const anthropicAlternates = isOnDemandBedrockModel(activeModelId)
      ? []
      : [sonnetModel, opusModel, sonnet5Model];
    for (const alternate of [...anthropicAlternates, ...onDemandAlternates]) {
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

  // Thinking level: always "default" — let OpenClaw decide per-model, per-provider.
  // No env override, no per-model forcing. Previously this forced "adaptive" onto every
  // Anthropic model in the catalog; removed so each model's own default behavior applies.
  defaults.thinkingDefault = "default";

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
  // Optional override: target a different region for Bedrock inference calls than the
  // infra's own deploy region (e.g. use a model only available in eu-north-1 while the
  // rest of the stack stays in eu-central-1). Falls back to awsRegion when unset.
  const bedrockRegion = process.env.BEDROCK_REGION ?? undefined;
  const workspacePath = process.env.OPENCLAW_WORKSPACE ?? "/data/workspace";

  // Restore persisted config from S3 before patching
  restoreConfigFromS3(configPath)
    .then(() => {
      patchConfig(configPath, { aiProvider, llmModel, awsRegion, bedrockRegion, workspacePath });
      console.log("[patch-config] Config patched successfully");
    })
    .catch((err) => {
      console.error("[patch-config] Fatal error:", err);
      process.exit(1);
    });
}
