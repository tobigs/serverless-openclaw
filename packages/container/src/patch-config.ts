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

  // Allow the agent to self-restart
  config.commands = { ...config.commands, restart: true };

  // Remove secrets — API keys delivered via env vars only
  if (config.auth) delete config.auth.token;
  delete config.llm;
  delete config.telegram;

  // Set model and workspace
  const agents = (config.agents ?? {}) as Record<string, unknown>;
  const defaults = (agents.defaults ?? {}) as Record<string, unknown>;

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

  if (options?.aiProvider === "bedrock") {
    process.env.AWS_PROFILE = "default";
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
