# Release Notes

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
