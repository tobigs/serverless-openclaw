# OpenClaw 2026.6 Upgrade Guide

This document captures everything learned upgrading from OpenClaw 2026.2.x to 2026.6.x,
including all the non-obvious failure modes and how to change models in the future.

## What Changed in 2026.6

### Breaking changes

| Area                      | 2026.2.x        | 2026.6.x                                                                      |
| ------------------------- | --------------- | ----------------------------------------------------------------------------- |
| Protocol version          | v3              | v4 (`minProtocol: 4, maxProtocol: 4` in client)                               |
| Bedrock provider          | Bundled in core | Separate npm package `@openclaw/amazon-bedrock-provider`                      |
| `models.bedrockDiscovery` | Supported       | **Removed** — causes schema error on startup                                  |
| `thinkingDefault`         | `thinking`      | `thinkingDefault` under `agents.defaults`                                     |
| `commands.ownerAllowFrom` | Optional        | **Required** — without it, gateway issues pairing codes instead of responding |
| Telegram native plugin    | Off by default  | **Auto-activated if `TELEGRAM_BOT_TOKEN` env var is set**                     |

### Plugin system

In 2026.6, the Bedrock provider is a proper plugin that must be:

1. Installed as an npm package (`@openclaw/amazon-bedrock-provider@<version>`)
2. Registered in OpenClaw's managed npm discovery path

OpenClaw discovers plugins via `~/.openclaw/npm/` (not global npm). It scans
`~/.openclaw/npm/package.json` dependencies and resolves each from `node_modules/`.
The Dockerfile creates this structure with a symlink to the globally installed package.

## How to Change Models

### Step 1: Find the correct model ID

For Bedrock in `eu-central-1`, Claude 4.x models require **cross-region inference profiles (CRIS)**
— direct foundation model invocation is rejected by the Converse API.

Available inference profiles in `eu-central-1`:

```bash
aws bedrock list-inference-profiles --region eu-central-1 \
  --query 'inferenceProfileSummaries[*].inferenceProfileId' --output json
```

The format is `{region-prefix}.anthropic.claude-{name}-{version}`:

- `eu-central-1` → prefix `eu` → `eu.anthropic.claude-sonnet-4-6`
- `us-east-1` → prefix `us` → `us.anthropic.claude-sonnet-4-6`
- `ap-northeast-1` → prefix `ap` → `ap.anthropic.claude-sonnet-4-6`

### Step 2: Set AI_MODEL in .env

```bash
# .env
AI_MODEL=eu.anthropic.claude-opus-4-8   # example: switch to Opus
```

`resolveBedrockModel()` in `packages/shared/src/provider-config.ts` applies the CRIS prefix
automatically from `AWS_REGION` if `AI_MODEL` is not set. If you set `AI_MODEL`, use the
**fully-qualified inference profile ID** (with prefix).

### Step 3: Deploy

```bash
make deploy-telegram   # deploys ComputeStack with new AI_MODEL env var
```

The new task definition will be used on the next cold start. To force it immediately:

```bash
make task-clean        # stops running task + clears DynamoDB TaskState
```

### What patch-config writes

`patch-config.ts` runs at every container startup and writes `openclaw.json` with:

```json
{
  "models": {
    "providers": {
      "amazon-bedrock": {
        "baseUrl": "https://bedrock-runtime.{region}.amazonaws.com",
        "api": "bedrock-converse-stream",
        "auth": "aws-sdk",
        "models": [
          {
            "id": "eu.anthropic.claude-sonnet-4-6",
            "name": "eu.anthropic.claude-sonnet-4-6",
            "contextWindow": 1000000,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "amazon-bedrock/eu.anthropic.claude-sonnet-4-6" }
    }
  }
}
```

This is why you must set `AI_MODEL` to the fully-qualified inference profile ID — it flows
through to both `models.providers.amazon-bedrock.models[0].id` and
`agents.defaults.model.primary`.

## Failure Modes We Hit (and How to Diagnose)

### "WebSocket not connected" after gateway restart

**Cause**: OpenClaw restarts its own gateway when it rewrites `openclaw.json`. The Bridge
WebSocket connection is severed with no reconnection logic.
**Fix**: `OpenClawClient` now has exponential backoff reconnection on `close` event.

### "Unknown model: amazon-bedrock/..." at inference time

This is the most complex failure. There are multiple root causes with identical symptoms:

**Root cause 1: Wrong model ID format**
OpenClaw logs `[gateway] agent model: amazon-bedrock/X` at startup. If X doesn't match
what the Bedrock API accepts, inference fails.

- Claude 4.x requires CRIS inference profile IDs (`eu.anthropic.claude-sonnet-4-6`)
- Foundation model IDs (`anthropic.claude-sonnet-4-6`) are rejected by Converse API

**Root cause 2: Plugin not installed in managed npm path**
The `@openclaw/amazon-bedrock-provider` package must be discoverable at
`~/.openclaw/npm/node_modules/@openclaw/amazon-bedrock-provider`.
Global npm install (`npm install -g`) is NOT enough — OpenClaw doesn't scan global packages.
Check: startup log shows `[plugins] loading amazon-bedrock from ...` — if this line is absent,
the plugin is not installed.

**Root cause 3: Discovery skipped (no AWS credential signal)**
The plugin's `resolveAwsSdkEnvVarName()` only checks `AWS_ACCESS_KEY_ID`, `AWS_PROFILE`,
and `AWS_BEARER_TOKEN_BEDROCK`. It does **not** detect Fargate IAM task role credentials
(the ECS metadata endpoint). Without `AWS_PROFILE=default` in the container environment,
`hasAwsCreds=false` and discovery is skipped.
Fix: `compute-stack.ts` injects `AWS_PROFILE=default` when `AI_PROVIDER=bedrock`.

**Root cause 4: Async discovery race**
Even with the plugin installed and credentials detected, dynamic discovery (calling
`ListFoundationModels`/`ListInferenceProfiles`) runs asynchronously at inference time.
The lane task can fail before discovery completes (155ms vs seconds for API call).
Fix: `patch-config.ts` writes `models.providers.amazon-bedrock` explicitly with the model
registered at config load time, bypassing discovery entirely.

**Root cause 5: Missing `name` field in model definition**
`ModelDefinitionSchema` requires `name: string().min(1)`. Omitting it causes a schema
validation error and the gateway exits cleanly (exit code 0). ECS reports "Essential container
exited" which looks like a crash but isn't logged as an error.
Fix: include `name: modelId` in the model entry.

### Config schema errors on startup ("Invalid input")

Stale keys from 2026.2.x that are rejected by 2026.6 schema:

- `models.bedrockDiscovery` — stripped by `patch-config`
- `telegram` / `channels.telegram` — stripped by `patch-config`
- `plugins.entries.telegram` — stripped by `patch-config`
- `mcp` — stripped by `patch-config` (re-added if `ENABLE_MCP=true`)
- `llm` — stripped by `patch-config`
- `auth.token` — stripped by `patch-config`

These all get written to `openclaw.json` by the gateway at runtime (session state, agent
customizations) and survive across container restarts via S3 backup. `patch-config` strips
them on every startup to prevent crashes.

### Gateway issues pairing code instead of responding

**Cause**: `commands.ownerAllowFrom` missing from config.
**Fix**: `patch-config` sets `commands.ownerAllowFrom: [USER_ID]`.

### Telegram bot silent (messages silently consumed by OpenClaw)

**Cause**: OpenClaw 2026.6 auto-activates its native Telegram plugin if `TELEGRAM_BOT_TOKEN`
is set in the container environment. It then calls `deleteWebhook` and starts competing with
our Lambda webhook handler.
**Fix**: Rename the env var to `BRIDGE_TELEGRAM_TOKEN` in `compute-stack.ts`. Our Bridge
reads `BRIDGE_TELEGRAM_TOKEN`; OpenClaw never sees `TELEGRAM_BOT_TOKEN`.

### Container health check failing / Bridge not ready

The Bridge `/health` endpoint returns 503 when the OpenClaw gateway WebSocket connection
is not established. This is intentional — ECS health checks use it to detect broken state.

## Deploy Sequence

The correct sequence for any change that affects the running container:

```
1. Edit code
2. npm run build          # verify no type errors
3. git commit             # pre-commit hook runs tests + lint
4. make deploy-telegram   # CDK: updates task definition (if CDK changed)
5. finch build + push     # if container code changed (src/, Dockerfile)
6. make task-clean        # stop running task + clear DynamoDB TaskState
7. Send Telegram message  # triggers cold start on new image
8. make task-logs         # watch startup logs
```

If you skip step 4 (CDK deploy), the new image runs with the old task definition env vars.
If you skip step 6, the old task keeps running — ECS won't restart it automatically.

Always use `make deploy-telegram` (or `make deploy-all`) rather than running `cdk deploy`
directly. The Makefile sources `.env` which carries `AI_PROVIDER`, `AI_MODEL`,
`EXTRA_TELEGRAM_BOTS`, and `THINKING_LEVEL` into the CDK context.

## Environment Variables Reference

| Var                           | Where set                     | Purpose                                                                                      |
| ----------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`                 | `.env` → CDK → ECS            | `bedrock` or `anthropic`                                                                     |
| `AI_MODEL`                    | `.env` → CDK → ECS            | Override default model (optional)                                                            |
| `AWS_REGION`                  | CDK → ECS                     | Region for Bedrock API calls                                                                 |
| `AWS_PROFILE`                 | CDK → ECS                     | Signals AWS creds available to OpenClaw plugin (set to `default` when `AI_PROVIDER=bedrock`) |
| `THINKING_LEVEL`              | `.env` → CDK → ECS            | `off\|minimal\|low\|medium\|high\|xhigh\|adaptive\|max`                                      |
| `BRIDGE_TELEGRAM_TOKEN`       | SSM → ECS secrets             | Primary bot token (renamed from `TELEGRAM_BOT_TOKEN`)                                        |
| `BRIDGE_TELEGRAM_TOKEN_COACH` | SSM → ECS secrets             | Extra bot tokens (pattern: `BRIDGE_TELEGRAM_TOKEN_{ID}`)                                     |
| `EXTRA_TELEGRAM_BOTS`         | `.env` → CDK → ECS            | JSON array of extra bot configs                                                              |
| `USER_ID`                     | Set by watchdog at task start | Telegram user ID (`telegram:NNNNN`)                                                          |
| `DATA_BUCKET`                 | CDK → ECS                     | S3 bucket for workspace + openclaw config backup                                             |
