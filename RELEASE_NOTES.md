# Release Notes

## v0.3.1 — Session Continuity (2026-03-15)

### Highlights

Unified session storage ensures conversation context is preserved when smart routing switches between Lambda and Fargate. Previously each runtime used different S3 paths, causing the bot to "forget" previous conversations after a routing transition.

### Fixes

- **Unified S3 session path**: Both Lambda and Fargate now read/write sessions to `sessions/{userId}/agents/default/sessions/{sessionId}.jsonl`
- **Fargate session sync**: `LifecycleManager` backs up and restores OpenClaw sessions to/from the shared S3 path
- **Shared constants**: `SESSION_S3_PREFIX`, `SESSION_DEFAULT_AGENT` in `@serverless-openclaw/shared`

### Integration Tests (11 new, 7 patterns)

- Lambda → Lambda (2 and 3 consecutive invocations)
- Fargate → Lambda transition
- Lambda → Fargate transition
- Mixed: Lambda → Fargate → Lambda
- Mixed: Fargate → Lambda → Fargate
- New session creation
- User isolation (separate users don't share sessions)

### Test Coverage

259 unit tests + 35 E2E tests = **294 total, all passing**

---

## v0.3.0 — Smart Routing (2026-03-15)

### Highlights

When `AGENT_RUNTIME=both`, the system now intelligently routes messages to Lambda or Fargate based on task characteristics — reusing running Fargate containers, honoring user hints (`/heavy`, `/fargate`), and automatically falling back to Fargate when Lambda fails.

### New Features

- **Smart routing** (`route-classifier.ts`): Dynamic Lambda/Fargate selection based on task state and message hints
- **Fargate reuse**: Running containers are reused instead of wasting them by routing to Lambda
- **User hints**: `/heavy` and `/fargate` message prefixes explicitly request Fargate runtime
- **Lambda fallback**: Automatic Fargate retry when Lambda invocation fails

### Test Coverage

248 unit tests + 35 E2E tests = **283 total, all passing**

---

## v0.2.1 — Security Hardening & Skill Restructuring (2026-03-15)

### Security Fixes

- **Timing-safe token comparison**: Bearer token (Bridge) and Telegram webhook secret now use `timingSafeEqual` to prevent timing side-channel attacks
- **S3 path traversal prevention**: `sessionId` and `userId` validated against `^[a-zA-Z0-9_:-]{1,128}$` before S3 key construction
- **Gateway Lambda log retention**: All 7 Lambda functions now have `ONE_WEEK` log retention (previously unbounded)
- **ECR lifecycle policy**: Lambda agent ECR repository limited to 5 images (prevents unbounded storage cost)

### Skills

13 Claude Code skills restructured to leverage all project documentation:
- 5 new: `/dev`, `/troubleshoot`, `/openclaw`, `/cold-start`, `/status`
- 1 new: `/release` — 6 parallel review lanes (code, docs, tests, security, cost, ops)
- 5 updated: `/deploy`, `/cost`, `/architecture`, `/security`, `/context`

### Documentation

- 22 documentation issues fixed (CRITICAL to LOW) from comprehensive review
- All Korean text translated to English (project rule compliance)
- Architecture diagrams updated for 9 CDK stacks and Lambda agent
- Test counts, package counts, and phase status synchronized across all docs

### Test Coverage

233 unit tests + 35 E2E tests = **268 total, all passing**

---

## v0.2.0 — Lambda Container Migration (2026-03-15)

### Highlights

OpenClaw now runs directly in AWS Lambda, eliminating all fixed compute costs. The Fargate runtime remains available as a fallback.

- **Zero idle cost**: Lambda charges only per invocation (~$0.00005/request)
- **1.35s cold start**: Down from 55.9s (97.6% reduction)
- **0.12s warm start**: Down from 34.6s (99.7% reduction)
- **Zero OpenClaw modifications**: Wrapper-only approach, fully upstream-compatible

### New Features

- **Lambda Agent Runtime** (`packages/lambda-agent/`): Runs OpenClaw's `runEmbeddedPiAgent()` in a Lambda Container Image (ARM64, 2048MB, 15min timeout)
- **S3 Session Persistence**: Session files (JSONL) synced between S3 and Lambda `/tmp` for cross-invocation continuity
- **DynamoDB Session Lock**: Conditional writes prevent concurrent session corruption
- **`AGENT_RUNTIME` Feature Flag**: `fargate` (default) | `lambda` | `both` — controls which compute path is deployed
- **CDK `LambdaAgentStack`**: ECR repository, DockerImageFunction, IAM (S3 + SSM + DynamoDB + CloudWatch)
- **Lambda routing in `routeMessage`**: Gateway Lambdas can invoke the agent Lambda directly alongside the existing Fargate Bridge path
- **`/lambda-migration` Claude Code skill**: Guided implementation for each migration step

### Performance

| Metric | Before (Fargate) | After (Lambda) | Change |
|--------|------------------|----------------|--------|
| Cold start | 55.9s | 1.35s | -97.6% |
| Warm start | 34.6s | 0.12s | -99.7% |
| Idle cost | ~$15/month | $0 | -100% |
| Memory (warm) | 1,270 MB | 119 MB | -90.6% |

### Breaking Changes

None. Default `AGENT_RUNTIME=fargate` preserves existing behavior. Opt-in to Lambda with `AGENT_RUNTIME=lambda` or `AGENT_RUNTIME=both`.

### Deployment Notes

- **Docker build requires `--provenance=false`**: Lambda doesn't support OCI manifest format
- **ECR repository must be pre-created**: Lambda needs the image to exist before CDK creates the function
- **CDK Bootstrap v30+ required**: Run `cdk bootstrap` if on v28 or earlier
- **Current operational mode: `both`**: Lambda primary with Fargate fallback during stabilization period

### Test Coverage

233 unit tests (30 files) + 35 E2E tests = **268 total, all passing**

### Files Changed

31 files changed, 2,410 insertions, 580 deletions

---

## v0.1.0 — MVP (2026-02-15)

### Highlights

Initial release of Serverless OpenClaw. Runs the OpenClaw AI agent on-demand on AWS serverless infrastructure with Web UI and Telegram interfaces.

### Features

- ECS Fargate Spot compute with ARM64 containers
- 7 Gateway Lambda functions (WebSocket, REST, Telegram, Watchdog, Prewarm)
- React SPA on S3 + CloudFront with Cognito authentication
- Telegram Bot integration with Web-Telegram identity linking (OTP)
- 5 DynamoDB tables (Conversations, Settings, TaskState, Connections, PendingMessages)
- Cold start message queuing via PendingMessages table
- Predictive pre-warming with EventBridge cron schedules
- CloudWatch monitoring dashboard with 8 custom metrics
- Docker image optimized: 2.22GB to 1.27GB (43% reduction)

### Test Coverage

198 unit tests + 28 E2E tests = 226 total
