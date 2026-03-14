# Lambda Migration Journey

> 2026-03-14, Single Claude Code Session | OpenClaw v2026.2.13 → AWS Lambda

This document records the complete journey of migrating OpenClaw from Fargate to AWS Lambda, captured from a single Claude Code conversation session. The entire process — from feasibility analysis to production E2E verification — was completed in one sitting.

## Timeline

```
14:03  Start: "Can we modify OpenClaw to run on AWS Lambda?"
14:08  Analysis complete: 5 approaches identified, A/E hybrid recommended
15:20  Decision: Zero-modification approach confirmed
15:35  Planning: docs, skill, GitHub epic + 5 issues created
15:42  Implementation starts (TDD)
15:46  Step 2-1 complete: lambda-agent package (25 tests)
15:56  Ralph mode: parallel execution of Steps 2-2~2-5
16:03  All 4 steps complete (268 tests pass)
16:06  Architect review: 2 IAM bugs found and fixed
16:08  All tests pass after IAM fix
16:10  Deployment begins
16:25  LambdaAgentStack deployed to AWS
16:40  First successful E2E: "Four" (55.9s cold start)
21:02  Cold start optimization starts
21:06  Optimization deployed: 55.9s → 1.35s (97.6% reduction)
21:08  Committed: 31 files, 2410 insertions
```

## Phase 1: Feasibility Analysis (14:03 – 14:08)

### The Question

> "Can we actually modify OpenClaw itself to run on AWS Lambda?"

### Key Discoveries

1. **`runEmbeddedPiAgent()`** — OpenClaw's agent runtime is fully independent of the Gateway WS server. It's exported via `extensionAPI.js`.

2. **`SessionManager` uses sync fs** — `readFileSync`, `appendFileSync`, `writeFileSync`. Works natively on Lambda's `/tmp`.

3. **File-not-found is safe** — `loadEntriesFromFile()` returns `[]` when file doesn't exist. New sessions work without pre-creating files.

4. **`HOME=/tmp` redirects everything** — OpenClaw reads config from `~/.openclaw/`. Setting `HOME=/tmp` makes it use `/tmp/.openclaw/`.

### 5 Approaches Evaluated

| Approach | Effort | OpenClaw Modifications |
|----------|--------|----------------------|
| A. Lambda Container + S3 session sync | Medium | **Zero** |
| B. Lambda + EFS | Low | Zero (but adds cost) |
| C. `node:fs` monkey-patch | High | Zero (but fragile) |
| D. Fork + storage adapter | Very High | Extensive |
| E. Lambda Response Streaming | Medium | Zero |

**Decision**: Approach A/E hybrid — Lambda Container Image with S3 session sync. **Zero OpenClaw code modifications**.

### Design Constraints

- OpenClaw evolves rapidly → can't fork, must stay upstream-compatible
- Cost target < $1/month → no fixed costs allowed
- Backward compatible → Fargate path must remain as fallback

## Phase 2: Planning & Skill Creation (15:20 – 15:35)

- Created `docs/lambda-migration-plan.md` with 5 implementation steps
- Created `/lambda-migration` Claude Code skill for guided implementation
- Created GitHub epic (#16) with 5 issues (#11–#15)
- Each issue has specific deliverables and acceptance criteria

## Phase 3: Implementation (15:42 – 16:08)

### Step 2-1: Lambda Container Image + Handler (15:42 – 15:46)

TDD approach: tests first, then implementation.

**Created `packages/lambda-agent/`:**
- `handler.ts` — Orchestrator: secrets → config → S3 download → agent run → S3 upload
- `session-sync.ts` — S3 ↔ `/tmp` JSONL file synchronization
- `config-init.ts` — Creates OpenClaw config in `/tmp/.openclaw/`
- `agent-runner.ts` — Dynamic import of `openclaw/dist/extensionAPI.js`
- `session-lock.ts` — DynamoDB conditional writes for concurrency control
- `secrets.ts` — SSM SecureString resolution with per-instance caching
- `Dockerfile` — Lambda Container Image (arm64, Node 22)

**Test challenges solved:**
- `vi.hoisted()` required for stable mock references across `vi.resetModules()`
- `SESSION_BUCKET` env var must be set in handler tests

### Steps 2-2 ~ 2-5: Ralph Parallel Execution (15:56 – 16:03)

Used Ralph mode to execute remaining steps in parallel with two specialist agents:

**Agent 1** (Session Lifecycle):
- `SessionLock` class with DynamoDB conditional writes
- 15-minute TTL matching Lambda max timeout
- `handler.ts` updated: acquire → try { agent } finally { release }

**Agent 2** (Feature Flag + Docs):
- `AGENT_RUNTIME` env var: `fargate` (default) | `lambda` | `both`
- CDK `app.ts`: conditional stack creation
- Documentation updates (architecture, deployment)

### Architect Review (16:03 – 16:08)

Opus-tier architect agent reviewed all changes and found **2 IAM bugs**:

1. **LambdaAgentStack missing DynamoDB permissions** — `SessionLock` writes to TaskState table, but CDK stack only granted S3/SSM/CloudWatch.
2. **ApiStack missing `lambda:InvokeFunction`** — Gateway Lambdas call the agent Lambda, but had no invoke permission.

Both fixed in minutes. All 268 tests pass.

## Phase 4: Deployment & E2E (16:10 – 16:40)

### Deployment Obstacles (7 issues resolved)

| # | Problem | Solution |
|---|---------|----------|
| 1 | Lambda needs image before ECR exists | Create ECR manually first, then CDK deploy |
| 2 | `tsc` fails — can't find `openclaw` module | Use variable path to prevent static resolution |
| 3 | `git` not in Lambda base image | `dnf install -y git` in Dockerfile |
| 4 | CDK Bootstrap v28, needs v30 | `cdk bootstrap` to update |
| 5 | ECR repo already exists from failed deploy | Force delete + recreate |
| 6 | OCI image manifest not supported by Lambda | `--provenance=false` flag |
| 7 | `openclaw` installed globally, Lambda resolves from `/var/task` | Install in `LAMBDA_TASK_ROOT/node_modules` |

### Module Resolution Chain (3 attempts)

The hardest problem was importing `extensionAPI.js` which exists in OpenClaw's dist but is **not listed in the package.json `exports` map** (v2026.2.13):

1. **`import("openclaw/dist/extensionAPI.js")`** → Blocked by exports map
2. **`require(absolutePath)`** → Blocked: extensionAPI.js is ESM, can't `require()` it
3. **`import(\`file://${absolutePath}\`)`** → Works! `file://` URL bypasses exports map

```typescript
const req = createRequire(__filename);
const mainPath = req.resolve("openclaw");  // Gets absolute path via exports
const extensionApiPath = mainPath.replace(/index\.js$/, "extensionAPI.js");
const mod = await import(`file://${extensionApiPath}`);  // Bypasses exports map
```

### First Successful E2E

```json
{
  "success": true,
  "payloads": [{ "text": "Four" }],
  "durationMs": 55898,
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514"
}
```

## Phase 5: Cold Start Optimization (21:02 – 21:08)

### Root Cause: Bedrock Discovery

CloudWatch logs revealed OpenClaw was calling `bedrock:ListFoundationModels` twice on every invocation — each call timing out after ~30 seconds due to missing IAM permissions:

```
WARN [bedrock-discovery] Failed to list models: AccessDeniedException
```

### The Fix: One Config Line

```typescript
const config = {
  gateway: { mode: "local" },
  models: { bedrockDiscovery: { enabled: false } },  // ← This line saves ~54 seconds
};
```

Plus caching the OpenClaw module import across warm invocations:

```typescript
let cachedRunEmbeddedPiAgent = null;
async function loadRunEmbeddedPiAgent() {
  if (cachedRunEmbeddedPiAgent) return cachedRunEmbeddedPiAgent;
  // ... import once, cache forever
}
```

### Results

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Cold start | 55.9s | 1.35s | **97.6%** |
| Warm start | 34.6s | 0.12s | **99.7%** |
| Memory | 1,270 MB | 119 MB | **90.6%** |
| Cost per request (1.5s) | — | ~$0.00005 | — |

## Final Architecture

```
[Fargate Path — AGENT_RUNTIME=fargate (default)]
Client → API GW → Lambda → Bridge(:8080) → OpenClaw Gateway(:18789) → Pi Agent

[Lambda Path — AGENT_RUNTIME=lambda]
Client → API GW → Lambda → Lambda Agent Container → runEmbeddedPiAgent() → Anthropic API
                               ↕ (S3 session sync)
                               S3 (sessions/{userId}/{sessionId}.jsonl)
```

### Cost Comparison

| | Fargate | Lambda |
|---|---------|--------|
| Idle cost | ~$15/month | **$0** |
| Per request | included | ~$0.00005 |
| 100 req/month | ~$15 | **~$0.005** |
| Fixed cost | Yes | **None** |

## Key Learnings

1. **OpenClaw is more modular than it looks** — `runEmbeddedPiAgent()` is a clean, independent function despite being part of a 675K-line monorepo with 86+ gateway methods.

2. **`file://` URL bypasses Node.js exports map** — When a file exists but isn't in `exports`, `import(\`file://\${absolutePath}\`)` is the only way to load ESM from CJS.

3. **Bedrock discovery is the #1 cold start killer** — A single config flag (`bedrockDiscovery.enabled: false`) saved 54 seconds per invocation. Always check what SDK calls your dependencies make on init.

4. **Docker `--provenance=false` is required for Lambda** — Docker buildx defaults to OCI manifests with provenance, which Lambda doesn't support.

5. **CDK chicken-and-egg with ECR** — Lambda needs an image in ECR, but CDK creates both ECR and Lambda in the same deploy. Solution: pre-create ECR externally, use `fromRepositoryName()` in CDK.

6. **Architect review catches IAM gaps** — The code logic was perfect, but two IAM permissions were missing. Always review CDK IAM alongside application code.

## Files Changed

```
31 files changed, 2410 insertions(+), 580 deletions(-)

New package: packages/lambda-agent/ (8 source + 4 test + Dockerfile)
New stack:   packages/cdk/lib/stacks/lambda-agent-stack.ts
New service: packages/gateway/src/services/lambda-agent.ts
New skill:   .claude/skills/lambda-migration/SKILL.md
New docs:    docs/lambda-migration-plan.md, docs/lambda-migration-journey.md
Updated:     api-stack.ts, app.ts, message.ts, types.ts, architecture.md, deployment.md
Tests:       233 UT + 35 E2E = 268 total (all pass)
```
