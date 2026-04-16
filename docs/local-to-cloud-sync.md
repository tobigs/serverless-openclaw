# Local OpenClaw → Serverless OpenClaw Sync

## Goal

Push your local OpenClaw setup (OAuth tokens, MCP server config, skills, workspace files) to S3
so the Fargate agent picks them up on next cold start. One-way, on-demand.

## Why

- OAuth flows (Gmail, Outlook, Google Tasks) require a browser. Do them locally once, push tokens to cloud.
- Iterate on skills and workspace files locally (no cold start), push when ready.
- Your local setup becomes the source of truth for agent configuration.

## Prerequisites

Before syncing, you need three values:

| Variable      | Where to find it                                                           |
| ------------- | -------------------------------------------------------------------------- |
| `DATA_BUCKET` | `.env` file in this repo, or `aws s3 ls \| grep openclaw`                  |
| `USER_ID`     | Run `aws s3 ls s3://{DATA_BUCKET}/openclaw-home/` to see existing prefixes |
| `AWS_PROFILE` | `.env` file — currently `default`                                          |

## What Gets Synced

| Source (local)                                | Destination (S3)           | Notes                                                      |
| --------------------------------------------- | -------------------------- | ---------------------------------------------------------- |
| `~/.openclaw/` (excl. openclaw.json, agents/) | `openclaw-home/{USER_ID}/` | OAuth tokens, managed skills                               |
| `~/.openclaw/workspace/`                      | `workspaces/{USER_ID}/`    | AGENTS.md, SOUL.md, USER.md, IDENTITY.md, workspace skills |

## What Is Excluded

- `openclaw.json` — cloud version has Fargate-specific config (port, AI provider, workspace
  path). Never overwrite it from local.
- `agents/` — session history stays independent between local and cloud.
- `skills/aws-sync/` — the sync skill itself doesn't need to be in the cloud workspace.

## Manual Sync Commands

```bash
# 1. Dry run first — review what will change
aws s3 sync ~/.openclaw/ s3://{DATA_BUCKET}/openclaw-home/{USER_ID}/ \
  --exclude "openclaw.json" \
  --exclude "agents/*" \
  --delete \
  --dryrun \
  --profile default

# 2. Real sync after confirming dry run output
aws s3 sync ~/.openclaw/ s3://{DATA_BUCKET}/openclaw-home/{USER_ID}/ \
  --exclude "openclaw.json" \
  --exclude "agents/*" \
  --delete \
  --profile default

# 3. Sync workspace files
aws s3 sync ~/.openclaw/workspace/ s3://{DATA_BUCKET}/workspaces/{USER_ID}/ \
  --exclude "skills/aws-sync/*" \
  --profile default
```

## Via the aws-sync Skill (Preferred)

Install the skill locally at `~/.openclaw/workspace/skills/aws-sync/SKILL.md`
(see `docs/aws-sync-skill.md` for the full skill content).

Then just tell your local agent:

```
Sync my local OpenClaw config to AWS
```

The skill handles dry run, confirmation, and execution.

## After Syncing

The Fargate agent picks up changes on next cold start. To trigger a cold start:

- Let the current container time out (10-30 min inactivity), then send a message
- Or stop the task manually via `make task-status` / AWS console

## Current Status

- [ ] Skill file created at `~/.openclaw/workspace/skills/aws-sync/SKILL.md`
- [ ] DATA_BUCKET identified
- [ ] USER_ID identified (check `aws s3 ls s3://{DATA_BUCKET}/openclaw-home/`)
- [ ] First dry run reviewed
- [ ] First real sync completed
- [ ] Fargate cold start verified — agent sees OAuth tokens and workspace files

## Known Issues to Fix First

The `feature/agent-self-config` branch needs to be merged and deployed before synced files
are fully effective:

- `startup.ts` doesn't yet restore `~/.openclaw/` from S3 on container start (only workspace is restored)
- `patch-config.ts` CLI entry point not yet active in deployed image

Until merged and redeployed, only workspace files (`workspaces/{USER_ID}/`) are restored.
OAuth tokens and MCP config synced to `openclaw-home/{USER_ID}/` will be ignored until then.
