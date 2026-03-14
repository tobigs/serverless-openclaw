# Phase 2: Lambda Container Migration Plan

> Goal: Replace Fargate container with Lambda Container Image to eliminate fixed costs while keeping OpenClaw code modifications at zero.

## Background

Currently serverless-openclaw runs OpenClaw in a Fargate container (~$0.50/day idle cost). By running OpenClaw's `runEmbeddedPiAgent()` directly inside a Lambda Container Image, we eliminate all fixed compute costs.

### Key Discovery

OpenClaw exports `runEmbeddedPiAgent()` via `openclaw/dist/extensionAPI.js` — a library entry point that bypasses CLI/Gateway server initialization. The agent runtime is fully independent of the WebSocket gateway.

### Architecture Comparison

```
[Current: Fargate]
Client → API GW → Lambda → Bridge(:8080) → OpenClaw Gateway(:18789) → Pi Agent

[Target: Lambda Container]
Client → API GW → Lambda Container Image → runEmbeddedPiAgent() → Anthropic API
                    ↕ (session sync)
                    S3
```

## Technical Feasibility (Verified)

| Aspect | Status | Details |
|--------|--------|---------|
| Library import | Verified | `extensionAPI.js` exports `runEmbeddedPiAgent` without CLI init |
| SessionManager | Verified | Uses sync fs (`readFileSync`, `appendFileSync`) — works on Lambda `/tmp` |
| File creation | Verified | `loadEntriesFromFile()` returns `[]` if file missing — new sessions OK |
| Config path | Verified | `HOME=/tmp` redirects `~/.openclaw/` to `/tmp/.openclaw/` |
| API key | Verified | `ANTHROPIC_API_KEY` env var (existing pattern) |
| Timeout | Compatible | Lambda 15min > Agent default 10min |
| Package size | Compatible | 94.8MB npm package → Container Image (10GB limit) |
| Streaming | Compatible | `onPartialReply` callback → API GW WebSocket push |

## Design Principles

1. **Zero OpenClaw modifications** — Wrapper layer only, upstream compatible
2. **Zero fixed costs** — Pay only for execution time
3. **Backward compatible** — Fargate path remains as fallback
4. **Incremental migration** — Both paths can coexist

## Implementation Steps

### Step 2-1: Lambda Container Image + Handler (Foundation)

**Goal**: Create a Lambda Container Image that can import and call `runEmbeddedPiAgent()`.

**Deliverables**:
- `packages/lambda-agent/Dockerfile` — arm64 Lambda container with OpenClaw pre-installed
- `packages/lambda-agent/src/handler.ts` — Lambda handler wrapping `runEmbeddedPiAgent()`
- `packages/lambda-agent/src/session-sync.ts` — S3 ↔ `/tmp` session file sync
- `packages/lambda-agent/src/config-init.ts` — OpenClaw config generation in `/tmp`
- `packages/lambda-agent/package.json` + `tsconfig.json`
- Unit tests for session-sync and config-init

**Design**:

```typescript
// handler.ts (simplified)
export async function handler(event: LambdaAgentEvent) {
  // 1. Initialize OpenClaw config in /tmp
  await initConfig({ anthropicApiKey: process.env.ANTHROPIC_API_KEY });

  // 2. Download session file from S3
  const sessionFile = await sessionSync.download(event.userId, event.sessionId);

  // 3. Run agent
  const result = await runEmbeddedPiAgent({
    sessionId: event.sessionId,
    sessionFile,
    workspaceDir: '/tmp/workspace',
    prompt: event.message,
    provider: 'anthropic',
    model: event.model ?? 'claude-sonnet-4-20250514',
    config: loadConfig(),
    disableTools: event.disableTools ?? false,
    onPartialReply: (delta) => pushToClient(event.connectionId, delta),
  });

  // 4. Upload session file back to S3
  await sessionSync.upload(event.userId, event.sessionId);

  return result;
}
```

**Validation**:
- [ ] `docker build` succeeds for Lambda container
- [ ] Handler can import `runEmbeddedPiAgent` from `extensionAPI.js`
- [ ] Unit tests pass for session sync and config init
- [ ] Local invoke with `docker run` returns agent response

### Step 2-2: CDK LambdaAgentStack

**Goal**: CDK stack that deploys the Lambda Container Image with proper IAM and networking.

**Deliverables**:
- `packages/cdk/lib/stacks/lambda-agent-stack.ts` — Lambda function from ECR container image
- ECR repository for Lambda container image
- IAM role with S3 (session read/write) + SSM (secrets) + CloudWatch permissions
- Environment variables: SSM paths, S3 bucket, region
- E2E test for CDK synth

**Design**:

```typescript
// Lambda function configuration
const agentFn = new lambda.DockerImageFunction(this, 'AgentFunction', {
  code: lambda.DockerImageCode.fromEcr(repository, { tagOrDigest: 'latest' }),
  architecture: lambda.Architecture.ARM_64,
  memorySize: 2048,          // Match current Fargate config
  timeout: Duration.minutes(15),
  ephemeralStorageSize: Size.gibibytes(2),  // For session files + workspace
  environment: {
    HOME: '/tmp',
    SSM_ANTHROPIC_API_KEY: '/serverless-openclaw/secrets/anthropic-api-key',
    SESSION_BUCKET: sessionBucket.bucketName,
  },
});
```

**Validation**:
- [ ] `cdk synth` succeeds with LambdaAgentStack
- [ ] No NAT Gateway created (Lambda outside VPC)
- [ ] IAM permissions are least-privilege
- [ ] E2E test verifies stack resources

### Step 2-3: Response Streaming Integration

**Goal**: Connect Lambda agent to API Gateway for real-time streaming responses.

**Deliverables**:
- Lambda Response Streaming configuration (Function URL with `RESPONSE_STREAM`)
- Modified `ws-message` Lambda to route to Lambda agent instead of Fargate Bridge
- Modified `telegram-webhook` Lambda to route to Lambda agent
- `routeMessage` service update: Lambda agent as primary, Fargate as fallback
- Streaming delta → WebSocket push integration

**Design**:

```
ws-message Lambda
  → routeMessage()
    → [Primary] Invoke Lambda agent (async, streaming)
    → [Fallback] Bridge HTTP (existing Fargate path)
```

**Validation**:
- [ ] Client receives streaming deltas via WebSocket
- [ ] Telegram receives complete responses
- [ ] Fallback to Fargate works when Lambda agent unavailable
- [ ] Cold start < 30 seconds

### Step 2-4: Session Lifecycle Management

**Goal**: Manage session files in S3 with proper lifecycle, cleanup, and consistency.

**Deliverables**:
- S3 bucket lifecycle policy (session file TTL, intelligent tiering)
- Session locking (prevent concurrent writes to same session)
- Session compaction support (large JSONL files)
- DynamoDB SessionState table update (track Lambda vs Fargate execution)
- Watchdog Lambda update (monitor Lambda agent health)

**Validation**:
- [ ] Concurrent message handling doesn't corrupt session files
- [ ] Old session files are cleaned up automatically
- [ ] Session compaction works across Lambda invocations
- [ ] Watchdog correctly monitors Lambda execution

### Step 2-5: Fargate Deprecation + Cost Verification

**Goal**: Make Lambda agent the default path and verify cost savings.

**Deliverables**:
- Feature flag: `AGENT_RUNTIME=lambda|fargate` (default: `lambda`)
- ComputeStack conditional: skip ECS resources when `AGENT_RUNTIME=lambda`
- Cost monitoring dashboard update
- Documentation update (`docs/deployment.md`, `docs/architecture.md`)
- Migration guide for existing deployments

**Validation**:
- [ ] `AGENT_RUNTIME=lambda` runs without any Fargate resources
- [ ] `AGENT_RUNTIME=fargate` still works (backward compatible)
- [ ] Monthly cost < $1 target with Lambda execution
- [ ] All existing tests pass
- [ ] Documentation reflects new architecture

## Cost Analysis

| Component | Fargate (current) | Lambda (target) |
|-----------|-------------------|-----------------|
| Idle | ~$15/month (1 vCPU, 2GB) | **$0** |
| Per request (1 min) | included | ~$0.002 |
| 100 req/month | ~$15 | **~$0.20** |
| 1000 req/month | ~$15 | **~$2.00** |
| S3 session storage | — | ~$0.01 |
| **Total (100 req)** | **~$15** | **~$0.21** |

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| OpenClaw upstream breaking change | Pin version, test on update, Fargate fallback |
| Cold start too slow | Container Image pre-warming, SnapStart evaluation |
| `/tmp` size exceeded | Ephemeral storage up to 10GB, session compaction |
| Lambda 15min timeout | Agent timeout configured to 10min |
| `extensionAPI.js` import side effects | Test in isolation, lazy import if needed |
| `node:sqlite` native module | Container Image includes native deps |

## Step Completion Status

| Step | Status |
|------|--------|
| 2-1 | Complete |
| 2-2 | Complete |
| 2-3 | Complete |
| 2-4 | Complete |
| 2-5 | Complete |
