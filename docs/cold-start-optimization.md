# Cold Start Optimization

> Region: ap-northeast-2 | Fargate ARM64 1 vCPU / 2048 MB

## Phase 1: Infrastructure Optimization (Complete)

All 5 optimizations applied. Cold start reduced from ~126-150s to **68.5s** (~52% reduction).

### 1.1 End-to-End Cold Start Timeline

```text
User sends message
    |
    v [~2.9s] Lambda (telegram-webhook / ws-message)
    |         RunTask + PendingMsg DDB write
    |
    v [~25s] ECS Fargate provisioning (estimated, with SOCI potential)
    |        Task scheduling -> ENI allocation -> Image pull -> Container start
    |
    v [parallel] S3 restore + History load (Promise.all)
    |
    v [~30-35s] * OpenClaw Gateway initialization *
    |           Plugin loading, Browser service, Canvas, Heartbeat...
    |
    v [~0.3s] WebSocket handshake (Client Ready)
    |
    v [~3s] Pending message consumption + AI response generation
    |
    v (background) IP discovery + TaskState update (non-blocking)
    |
    Response received

Total: ~68.5s (measured 2026-02-15, 1 vCPU + OpenClaw v2026.2.13)
Previous: ~126-150s (2026-02-14, before optimizations)
```

### 1.2 Latest Measurement (2026-02-15)

Measured via `make cold-start` (WebSocket channel, cold start from idle):

| Metric | Value |
| ------ | ----- |
| Start type | COLD (container idle -> RunTask) |
| "Starting" status | +2.5s |
| **First response** | **68.5s** |
| **Stream complete** | **68.6s** |
| Messages total | 3 |

**Improvement from baseline:**

| Version | First Response | Reduction |
| ------- | -------------- | --------- |
| Baseline (0.5 vCPU, serial startup) | ~126-150s | -- |
| After CPU upgrade only (1 vCPU) | ~76.8s | ~40% |
| **All optimizations applied (1 vCPU, v2026.2.13)** | **68.5s** | **~52%** |

Timing breakdown (estimated from 68.5s total):
- Lambda -> ECS RunTask trigger: ~2.5s
- ECS provisioning + Container startup + Gateway init: ~63s
- AI inference (first token): ~3s

### 1.3 Applied Optimizations

#### P1: CPU Upgrade (0.5 -> 1 vCPU) -- APPLIED

| Item | Value |
| ---- | ----- |
| Impact | Gateway init 80s -> 40-50s (~40% reduction) |
| Cost | +$0.02048/hr (Fargate vCPU rate), +$0.005/session at 15 min |
| Status | Applied (CPU 512->1024, Memory 1024->2048) |

#### P2: SOCI Lazy Loading -- APPLIED

| Item | Value |
| ---- | ----- |
| Impact | Fargate provisioning 35s -> 15-20s (~50% reduction) |
| Cost | None |
| Status | Applied (GitHub Actions workflow: `.github/workflows/deploy-image.yml`) |

#### P3: Container Startup Parallelization -- APPLIED

| Item | Value |
| ---- | ----- |
| Impact | ~5s savings from serial segment |
| Cost | None |
| Status | Applied (`startup.ts`: Promise.all for S3+History, non-blocking IP discovery) |

Parallelization design:
```text
S3 restore ---+
              +--- Gateway wait -> Client ready ---+
              |                                     +--- Bridge + Pending consume
History load -+                                     |
                             IP discovery ----------+ (background, non-blocking)
```

#### P4: Dynamic Inactivity Timeout -- APPLIED

| Item | Value |
| ---- | ----- |
| Impact | 50-75% reduction in cold start frequency during active hours |
| Cost | Near-neutral (+$0.25-0.35/mo) |
| Status | Applied (watchdog Lambda: active hours 30min / inactive hours 10min) |

Approach: Watchdog Lambda queries CloudWatch `MessageLatency` to detect active hours (KST). If the current hour-of-day had messages on >= 2 of the past 7 days, use 30-min timeout (active). Otherwise, use 10-min timeout (inactive). First 7 days fall back to the current 15-min default.

#### P5: Lambda Stale IP Timeout Fix -- APPLIED

| Item | Value |
| ---- | ----- |
| Impact | Stale state: 10.5s timeout -> immediate fallback (PendingMsg queuing) |
| Cost | Lambda cost reduction |
| Status | Applied (3s Bridge timeout, fallback to PendingMsg + deleteTaskState, watchdog stale detection) |

#### Combined Impact (Estimated vs Actual)

| Scenario | Estimated | Actual |
| -------- | --------- | ------ |
| Baseline (0.5 vCPU, serial) | ~128s | ~126-150s |
| P1 only (CPU 1 vCPU) | ~88s | ~76.8s |
| **All applied (P1-P5, 1 vCPU)** | **~68s** | **68.5s** |

Total improvement: **~52% reduction** from baseline.

### 1.4 Baseline CloudWatch Metrics (2026-02-14, pre-optimization)

#### Container Startup Metrics (Namespace: ServerlessOpenClaw)

| Metric | Telegram avg | Web avg | Share |
| ------ | ------------ | ------- | ----- |
| **StartupTotal** | 95.6s | 97.7s | 100% |
| StartupS3Restore | 1.0s | 1.5s | ~1.3% |
| **StartupGatewayWait** | **77.9s** | **80.6s** | **~82%** |
| StartupClientReady | 0.2s | 0.3s | ~0.3% |
| Other (IP/State/Bridge) | ~16.5s | ~15.3s | ~16% |

> Note: All metrics include a `Channel` dimension (telegram/web). Querying without dimensions returns empty results.

#### Runtime Metrics

| Metric | Telegram | Web |
| ------ | -------- | --- |
| MessageLatency avg | 58.4s | 50.3s |
| MessageLatency min (warm) | 18.5s | 4.2s |
| MessageLatency max (cold) | 137.4s | 155.5s |
| FirstResponseTime | 127.5s | 233.9s |

- **MessageLatency min** (warm state) represents pure AI response generation time
- **MessageLatency max** (cold state) includes PendingMessage queuing wait time
- **FirstResponseTime** = container startup + first AI response generation time

#### Container Log Samples (3 samples, 2026-02-14)

| Container | Total | S3 | **Gateway** | Client |
| --------- | ----- | --- | ----------- | ------ |
| 95a3... (07:17) | 112.9s | 1.7s | **81.0s** | 107ms |
| bb0b... (06:51) | 101.4s | 1.2s | **76.6s** | 387ms |
| 4159... (06:39) | 90.1s | 1.4s | **80.1s** | 291ms |

#### Lambda Execution Times (telegram-webhook)

| Type | Init | Duration | Total |
| ---- | ---- | -------- | ----- |
| Cold start (RunTask) | ~540ms | ~2.2-3.5s | ~3-4s |
| Warm (bridge forward) | -- | ~450-530ms | ~500ms |
| Stale IP timeout | -- | ~10.5s | ~10.5s |

### 1.5 Bottleneck Analysis

#### OpenClaw Gateway Initialization: 78-81s (65% of baseline)

Tasks performed by `openclaw gateway run`:
1. Config loading and doctor execution
2. 30+ plugin initialization
3. Browser control service startup (Chromium profiles)
4. Canvas host mounting
5. Heartbeat startup
6. WebSocket server binding

**Outside our control**: Internal initialization logic of the OpenClaw binary.

CPU scaling history:
- 0.25 vCPU -> 120s (exceeded timeout)
- 0.5 vCPU -> 80s (previous)
- 1.0 vCPU -> ~35s (current, measured)

#### ECS Fargate Provisioning: ~35s (28% of baseline)

Measured by delta between Lambda REPORT timestamp and container first log:
- Lambda 06:39:08 -> Container 06:39:43 = **~35 seconds**

Docker image: 217 MB zstd compressed (ECR), ~1.27 GB uncompressed.

#### Lambda Stale IP Timeout Issue (resolved)

Between 06:48-06:50, 6 Lambda invocations failed with "fetch failed" at ~10.5s each. The previous container had stopped but TaskState still contained a stale IP, causing Bridge HTTP requests to time out. Resolved by P5 (3s timeout + fallback).

---

## Phase 2: Gateway Init Reduction (Complete)

> Research completed 2026-02-15. Lambda migration achieved via `runEmbeddedPiAgent()` in project Phase 2.

Gateway init (~30-35s) remains the largest single bottleneck (~52% of total cold start). Since `openclaw gateway run` is an external binary, optimization options are constrained.

### 2.1 Remaining Bottleneck

| Component | Duration | Share |
| --------- | -------- | ----- |
| Lambda -> RunTask | ~2.5s | 4% |
| ECS provisioning | ~25s | 37% |
| **Gateway init** | **~35s** | **~51%** |
| Client ready + AI response | ~3s | 4% |

### 2.2 Approaches Evaluated

#### P6: zstd Container Image Compression -- APPLIED

| Item | Value |
| ---- | ----- |
| Impact | Image size 258 MB -> 217 MB (-16%), First response -2.5s |
| Cost | None |
| Status | Applied (`scripts/deploy-image.sh`, `.github/workflows/deploy-image.yml`) |

Build command:
```bash
docker buildx build \
  --platform linux/arm64 \
  -t $ECR_REPO:latest \
  --provenance=false \
  --output type=image,push=true,compression=zstd,compression-level=3,force-compression=true \
  -f packages/container/Dockerfile .
```

Measurement (GitHub issue #7):

| Metric | Before (gzip) | After (zstd) | Delta |
| ------ | -------------- | ------------- | ----- |
| Image size (compressed) | 258 MB | 217 MB | -16% |
| First response | 67.8s | 65.3s | -2.5s |
| Stream complete | 69.9s | 65.7s | -4.2s |

> Note: Single-run measurement. Variance between runs is expected (~3-5s) due to ECS provisioning and AI inference time differences.

**Source**: [AWS Blog -- Reducing Fargate Startup with zstd](https://aws.amazon.com/blogs/containers/reducing-aws-fargate-startup-times-with-zstd-compressed-container-images/)

#### P7: Configurable CPU (default 1 vCPU, optional 2 vCPU) -- APPLIED

| Item | Value |
| ---- | ----- |
| Impact | 2 vCPU: 65.3s -> 55.8s (-14.5%). Default 1 vCPU: 68.5s |
| Cost | 1 vCPU: baseline, 2 vCPU: +$0.01/session |
| Status | Applied (CDK `FARGATE_CPU`/`FARGATE_MEMORY` env configurable, default 1024/2048) |

CPU scaling history:

| CPU | Gateway Init (measured) | Monthly Cost Delta |
| --- | ----------------------- | ------------------ |
| 0.25 vCPU | ~120s (timeout) | baseline |
| 0.5 vCPU | ~80s | -- |
| 1 vCPU | ~35s | +$0.005/session |
| **2 vCPU** | **~25s (estimated from 55.8s total)** | **+$0.01/session** |

#### P8: OpenClaw Version Management -- APPLIED

| Item | Value |
| ---- | ----- |
| Impact | Configurable version via `OPENCLAW_VERSION` build arg, pinned to v2026.2.13 |
| Cost | None |
| Status | Applied (Dockerfile `ARG OPENCLAW_VERSION=2026.2.13`, deploy scripts pass version) |

Dockerfile uses `openclaw@${OPENCLAW_VERSION}` build arg (default: `2026.2.13`). Version can be overridden via `OPENCLAW_VERSION` env var in `deploy-image.sh` or GitHub Actions workflow input.

Version compatibility testing (2026-02-15):

| Version | Status | First Response |
| ------- | ------ | -------------- |
| v2026.2.9 | Working | 65.3s |
| v2026.2.13 | Working | 57.9s |
| v2026.2.14 | **Broken** | "missing scope: operator.write" |

v2026.2.14 introduced a default-deny scope system requiring device pairing. Without paired device, `operator.write` scope is stripped, causing `chat.send` to fail. Pinned to v2026.2.13 (last compatible + fastest).

#### P9: Predictive Pre-Warming (EventBridge Scheduled Scaling) -- APPLIED

| Item | Value |
| ---- | ----- |
| Impact | Eliminates cold start during scheduled hours (**0s** first response) |
| Cost | Only pay for actual running time (e.g., 8hr/day = ~$8-10/month) |
| Status | Applied (prewarm Lambda + EventBridge conditional rules) |

Pre-launches a container before expected usage windows using EventBridge cron + Lambda.

```
EventBridge (cron schedule) -> prewarm Lambda -> ECS RunTask (USER_ID=system:prewarm)
                                              -> TaskState { prewarmUntil: now + duration }
```

**Configuration** (`.env`):
```bash
PREWARM_SCHEDULE="0 9 ? * MON-FRI *,0 14 ? * SAT-SUN *"  # comma-separated crons
PREWARM_DURATION=60  # minutes (default: 60)
```

**Container claiming**: When a real user sends a message and no user-specific container is running, the system checks for a pre-warmed container (`system:prewarm`). If found and reachable, the message is routed to it and TaskState ownership is transferred from `system:prewarm` to the real user. No cold start delay.

**Watchdog integration**: Pre-warmed containers have `prewarmUntil` timestamp in TaskState. The watchdog skips inactivity checks while `now < prewarmUntil`, preventing premature shutdown. After expiry, normal inactivity timeout applies.

**Overlap handling**: If a container is already running when prewarm triggers, the Lambda extends `prewarmUntil` on the existing task instead of starting a new one.

**Metrics**: `PrewarmTriggered` (new container started), `PrewarmSkipped` (existing container reused). Added to MonitoringStack dashboard.

#### P10: Warm Standby Container (desiredCount=1)

**Status: Most effective, but expensive**

Keep a single Fargate task always running via ECS Service.

| Item | Value |
| ---- | ----- |
| Expected impact | Cold start -> 0s (always warm) |
| Monthly cost (On-Demand) | ~$35-40/month (1 vCPU, 2 GB, ARM64, ap-northeast-2) |
| Monthly cost (Spot) | ~$10-12/month (70% discount, risk of interruption) |

Cost calculation (US East reference, Seoul ~10-20% higher):
- vCPU: $0.03238/hr x 730h = $23.64
- Memory: $0.00356/hr/GB x 2GB x 730h = $5.20
- **Total On-Demand: ~$28.84/month** (US East), **~$32-38/month** (Seoul estimated)
- **Fargate Spot: ~$9-12/month** (70% discount)

**Trade-off**: Conflicts with the project's $1/month cost target. Only viable if usage grows enough to justify the cost.

#### Blocked Approaches

| Approach | Status | Reason |
| -------- | ------ | ------ |
| Lambda SnapStart | Blocked (runtime) | Not available for Node.js (Java/Python 3.12+/.NET 8 only) |
| Lambda migration | Blocked (architecture) | Gateway requires persistent WebSocket server + Chromium (see Section 2.3). (Note: Lambda migration was achieved in project Phase 2 via `runEmbeddedPiAgent()`, bypassing the Gateway server entirely) |
| OpenClaw headless mode | Blocked (upstream) | No documented flags for disabling plugins or minimal mode |
| CRIU checkpoint/restore | Blocked (Fargate) | No host-level kernel access on Fargate |
| OpenClaw lazy plugin loading | Blocked (upstream) | Requires OpenClaw to support deferred init |

### 2.3 Lambda SnapStart / Lambda Migration Analysis

> Research completed 2026-02-15 via OpenClaw codebase analysis (`references/openclaw`) + Perplexity queries.

**Conclusion: Not viable.** Both Lambda SnapStart and migrating the Gateway to Lambda are blocked by fundamental architectural incompatibilities.

#### Lambda SnapStart Limitations

Lambda SnapStart creates a pre-initialized snapshot of the execution environment to eliminate cold starts. However:

| Constraint | Detail |
| ---------- | ------ |
| **Runtime support** | Java (11/17/21/25), Python 3.12+, .NET 8 only. **Node.js not supported.** |
| **Snapshot scope** | Captures memory state after `init` phase only. Cannot snapshot running servers or open connections. |
| **Execution model** | Lambda is request-response (max 15 min). Cannot host persistent WebSocket servers. |

Even if Node.js were supported, SnapStart snapshots the init phase — the Gateway's 30-35s init would need to complete before snapshot, and the resulting snapshot cannot include bound sockets or running services.

#### OpenClaw Gateway Architecture (Why Lambda Is Incompatible)

Analysis of the OpenClaw source code reveals the following architecture:

**Runtime:** Node.js 22, TypeScript compiled via `tsdown`, entry: `openclaw.mjs` → `dist/entry.js` → CLI → `startGatewayServer()`

**Startup sequence** (`src/gateway/server.impl.ts`):

```text
1. Config loading, validation, legacy migration
2. Plugin auto-enable + plugin loading (jiti TypeScript JIT)
   - 36+ extensions discovered from extensions/ directory
   - Synchronous register() calls per plugin
3. Runtime config resolution (auth, TLS, bind mode)
4. Canvas host server startup (HTTP + WebSocket on separate port)
5. WebSocket server binding (port 18789, persistent connections)
6. Sidecars (parallel):
   - Browser control server (Playwright + Chromium)
   - Gmail watcher
   - Internal hooks loader
   - Channel startup (Telegram, Discord, Slack, WhatsApp, etc.)
   - Plugin services
   - Memory backend
   - Bonjour/mDNS discovery
   - Heartbeat runner
   - Cron scheduler
```

**Lambda-incompatible components:**

| Component | Reason |
| --------- | ------ |
| WebSocket server (:18789) | Lambda cannot bind/listen on ports. API Gateway WebSocket API uses a different model (discrete event handlers). |
| Browser control (Playwright) | Requires persistent Chromium process. Lambda has 512MB `/tmp`, 10GB ephemeral storage max — Chromium alone needs ~400MB+ RAM. |
| Canvas host (HTTP+WS server) | Separate server process on its own port. |
| Plugin system (36+ extensions) | Heavy synchronous init via `jiti` transpiler. Each plugin calls `register()` during load. |
| Docker image (1.27GB) | Lambda container images support up to 10GB but cold start scales with image size. 1.27GB → estimated 5-30s+ image pull alone. |

**Environmental skip flags** (exist but insufficient):

| Flag | Skips |
| ---- | ----- |
| `OPENCLAW_SKIP_BROWSER_CONTROL_SERVER=1` | Playwright/Chromium |
| `OPENCLAW_SKIP_CANVAS_HOST=1` | Canvas UI server |
| `OPENCLAW_SKIP_CHANNELS=1` | Channel initialization |
| `OPENCLAW_SKIP_GMAIL_WATCHER=1` | Email watcher |
| `OPENCLAW_SKIP_CRON=1` | Cron jobs |
| `plugins.enabled: false` | All plugins |

Even with all optional services disabled, the core Gateway still requires a persistent WebSocket server for client connections and the JSON-RPC protocol handler — fundamentally incompatible with Lambda's request-response model.

**Test-only minimal mode** (`OPENCLAW_TEST_MINIMAL_GATEWAY=1`) exists but is gated behind `VITEST=1` and is not designed for production use.

### 2.4 Phase 2 Priority Matrix

| Priority | Approach | Impact | Cost | Effort |
| -------- | -------- | ------ | ---- | ------ |
| ~~P6~~ | ~~zstd compression~~ | ~~-2.5s, -16% image~~ | ~~Free~~ | ~~APPLIED~~ |
| ~~P7~~ | ~~CPU 2 vCPU~~ | ~~-9.5s (-14.5%)~~ | ~~+$0.01/session~~ | ~~APPLIED~~ |
| ~~P8~~ | ~~OpenClaw version management~~ | ~~v2026.2.13 pinned (-7.4s)~~ | ~~Free~~ | ~~APPLIED~~ |
| ~~P9~~ | ~~Predictive pre-warming~~ | ~~Eliminates cold start (scheduled)~~ | ~~$8-10/month~~ | ~~APPLIED~~ |
| P10 | Warm standby (Spot) | Eliminates cold start | ~$10-12/month | Low |

### 2.5 Projected Cold Start

| Scenario | First Response |
| -------- | -------------- |
| Phase 1 complete (1 vCPU) | 68.5s |
| + P6 zstd + P8 v2026.2.13 | 68.5s (current, within variance) |
| + P7 CPU 2 vCPU (optional) | 55.8s |
| + P9 Predictive pre-warming | **0s** (during active hours) |

---

## Infrastructure Specs

| Item | Value |
| ---- | ----- |
| Fargate CPU | 1 vCPU (1024) -- default, configurable via `FARGATE_CPU` env |
| Fargate Memory | 2048 MB -- default, configurable via `FARGATE_MEMORY` env |
| Architecture | ARM64 |
| Docker Image | 218 MB (zstd compressed) |
| OpenClaw Version | v2026.2.13 (pinned, v2026.2.14 breaks scope) |
| Inactivity Timeout | Dynamic (active: 30min / inactive: 10min) |
| Lambda Runtime | Node.js 20 |
| Lambda Memory | 256 MB |

## References

- [AWS Blog -- Reducing Fargate Startup with zstd](https://aws.amazon.com/blogs/containers/reducing-aws-fargate-startup-times-with-zstd-compressed-container-images/)
- [AWS Lambda SnapStart](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html) -- Supported runtimes: Java, Python 3.12+, .NET 8 (Node.js not supported)
- [AWS Lambda Container Image Support](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html) -- Up to 10GB images, but cold start scales with size
- [CRIU on Containers](https://www.devzero.io/blog/checkpoint-restore-with-criu)
- [Using CRaC on EKS](https://aws.amazon.com/blogs/containers/using-crac-to-reduce-java-startup-times-on-amazon-eks/)
- [Fargate vs Lambda Decision Guide](https://docs.aws.amazon.com/decision-guides/latest/fargate-or-lambda/fargate-or-lambda.html)
- [OpenClaw Gateway Configuration](https://docs.openclaw.ai/gateway/configuration)
- [Fargate Task Recommendations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-recommendations.html)
