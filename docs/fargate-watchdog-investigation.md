# Fargate Watchdog / RAM Investigation

Date: 2026-04-22
Scope: Read-only investigation. No production code was modified.

Account: `<REDACTED>` · Region: `eu-central-1` · Cluster: `serverless-openclaw`

## Summary

Containers are being killed by the watchdog Lambda ~10–15 minutes after the task starts even while the user is actively chatting. Root cause: the gateway's `routeFargate` happy path — message sent to a Running container — never writes `lastActivity` back to DynamoDB. `lastActivity` is only advanced on task start or prewarm claim, so every subsequent inbound message during an active session leaves the DDB timestamp pinned to the task's start time. Once the watchdog's inactive-hour branch fires (driven by sparse CloudWatch `MessageLatency` history and `ACTIVE_HOUR_THRESHOLD = 2`), the task is killed for "inactivity" despite live traffic.

The reported "4 vCPU / 16 GB" inside the container is a mix of truth and host-view: the Fargate task definition in use is `cpu=4096, memory=8192` (4 vCPU / 8 GB), and `os.totalmem()` reports the underlying host (~16 GB), not the task cap.

## Task 1 — Kill cause

All three most recently stopped tasks were killed by the watchdog Lambda. `aws ecs describe-tasks` output (relevant fields only):

| Task ID (short) | `startedAt` (UTC+2) | `stoppingAt` (UTC+2) | Uptime  | `stopCode`      | `stoppedReason`                | `exitCode` | `healthStatus` |
| --------------- | ------------------- | -------------------- | ------- | --------------- | ------------------------------ | ---------- | -------------- |
| `eed6bc8f`      | 2026-04-22 09:22:08 | 09:42:49             | ~20m40s | `UserInitiated` | `Watchdog: inactivity timeout` | 137        | `HEALTHY`      |
| `a1d4a294`      | 2026-04-22 09:46:16 | 10:02:49             | ~16m33s | `UserInitiated` | `Watchdog: inactivity timeout` | 137        | `HEALTHY`      |
| `3cb07c3e`      | 2026-04-22 10:04:23 | 10:17:50             | ~13m27s | `UserInitiated` | `Watchdog: inactivity timeout` | 137        | `HEALTHY`      |

- `stopCode=UserInitiated` + `stoppedReason="Watchdog: inactivity timeout"` matches the literal string passed to `StopTaskCommand` in `packages/gateway/src/handlers/watchdog.ts:150`.
- `exitCode=137` = `128 + 9` (SIGKILL), which is expected when ECS escalates after the container fails to exit within the stop grace period — this is a clean watchdog kill, not an OOM (an OOM would set `OutOfMemoryError` in `stoppedReason`).
- `healthStatus=HEALTHY` rules out a platform-level health-check failure.
- All three `stoppingAt` timestamps align with watchdog cron ticks at `:xx:49 UTC+2` (watchdog runs every 5 min).

Watchdog Lambda logs (`/aws/lambda/serverless-openclaw-watchdog`, limit 200, 09:15–10:25 UTC+2) contain only `INIT_START` / `START` / `END` / `REPORT` records — no application `console.log` output at all. Every invocation finishes in < 1 s with `Max Memory Used ≈ 110 MB / 256 MB` allocated.

Conclusion: the watchdog is the killer. No OOM, no platform eviction, no health-check failure.

## Task 2 — DynamoDB `lastActivity` behavior

The live `TaskState` row for the affected user is empty because the watchdog `DeleteCommand`s the row when it kills the task (`packages/gateway/src/handlers/watchdog.ts:155`). Instead of a live snapshot, the freeze hypothesis was confirmed from container logs. For task `3cb07c3e` (started 08:04:23 UTC, stopped 08:17:50 UTC):

| Time (UTC)          | Event in container logs                                                              | DDB `lastActivity` source                              |
| ------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 08:04:23            | task created                                                                         | `startedAt` set by gateway on task start               |
| 08:07:07            | bridge listening on 8080, pending messages claimed                                   | —                                                      |
| 08:07:17            | `Processed 1 pending message(s)`                                                     | gateway writes `lastActivity = now` on inbound message |
| 08:07:17 → 08:17:49 | only telegram `getUpdates` 409 errors (webhook conflict), no bridge `/message` calls | **unchanged** — bridge never writes to DDB mid-turn    |
| 08:17:49            | watchdog runs, `inactiveMs = 10m32s > 10m`                                           | row deleted by watchdog                                |

The "freeze" is structural, not accidental:

- `packages/container/src/bridge.ts:48` — `lifecycle.updateLastActivity()` updates an in-memory `Date` only.
- `packages/container/src/lifecycle.ts:37` — the setter never calls DynamoDB.
- `packages/gateway/src/services/message.ts:124,157` — only the gateway writes `lastActivity` to DDB, and only on inbound WS messages.

So any period > `INACTIVE_TIMEOUT_MS` (or > `INACTIVITY_TIMEOUT_MS` / `ACTIVE_TIMEOUT_MS` depending on branch) between successive user messages is indistinguishable from a truly idle container, even if the agent is mid-turn.

The watchdog scan at `packages/gateway/src/handlers/watchdog.ts:73` is additionally eventually consistent (no `ConsistentRead`), which adds at most a few seconds of staleness — minor compared to the structural freeze.

## Task 3 — Which timeout branch fired

Resolved without touching `getActiveTimeout()` by reproducing the classification externally. CloudWatch metric `ServerlessOpenClaw / MessageLatency`, dimension `Channel`, period 3600, over the last 7 days:

```text
Telegram datapoints (16 total):
  2026-04-16T09:00:00Z KST_hour=18 SampleCount=1
  2026-04-16T10:00:00Z KST_hour=19 SampleCount=1
  2026-04-16T21:00:00Z KST_hour=6  SampleCount=13
  2026-04-16T22:00:00Z KST_hour=7  SampleCount=10
  2026-04-17T08:00:00Z KST_hour=17 SampleCount=1
  2026-04-17T09:00:00Z KST_hour=18 SampleCount=1
  2026-04-17T10:00:00Z KST_hour=19 SampleCount=5
  2026-04-20T09:00:00Z KST_hour=18 SampleCount=3
  2026-04-20T10:00:00Z KST_hour=19 SampleCount=8
  2026-04-20T11:00:00Z KST_hour=20 SampleCount=10
  2026-04-21T15:00:00Z KST_hour=0  SampleCount=14
  2026-04-21T16:00:00Z KST_hour=1  SampleCount=19
  2026-04-21T19:00:00Z KST_hour=4  SampleCount=5
  2026-04-21T20:00:00Z KST_hour=5  SampleCount=6
  2026-04-22T07:00:00Z KST_hour=16 SampleCount=5
  2026-04-22T08:00:00Z KST_hour=17 SampleCount=9
Web datapoints: 0
```

`getActiveTimeout()` filters by `dpHourKST === currentHourKST` across telegram + web, then compares to `ACTIVE_HOUR_THRESHOLD = 2`:

| Task       | Kill time (UTC) | KST hour | Matching datapoints at kill time                                       | Branch                                                   | Applied cutoff |
| ---------- | --------------- | -------- | ---------------------------------------------------------------------- | -------------------------------------------------------- | -------------- |
| `eed6bc8f` | 07:42:49        | 16       | 1 (`2026-04-22T07:00:00Z`)                                             | `1 < 2` → `INACTIVE_TIMEOUT_MS`                          | 10 min         |
| `a1d4a294` | 08:02:49        | 17       | 1 (`2026-04-17T08:00:00Z`), current-hour bucket too young at kill      | `1 < 2` → `INACTIVE_TIMEOUT_MS`                          | 10 min         |
| `3cb07c3e` | 08:17:49        | 17       | 1–2 (`2026-04-17T08:00:00Z`, ± current-hour bucket partially ingested) | `≤ 2`; uptime vs. inactivity math forces a 10-min branch | 10 min         |

The observed kill timings (13m27s, 16m33s, 20m40s of uptime with `lastActivity` pinned to the first pending-message processing) are only consistent with a 10-minute cutoff. A 30-minute cutoff would have kept all three alive; a 15-minute fallback (`INACTIVITY_TIMEOUT_MS`) would have kept `3cb07c3e` alive (10m32s < 15m).

Conclusion: every kill was an `INACTIVE_TIMEOUT_MS (10 min)` branch, driven by sparse 7-day CloudWatch history for the kill hour. The silent `catch {}` at `packages/gateway/src/handlers/watchdog.ts:56` is not implicated in these incidents, but it would hide any CloudWatch error and silently fall back to 15 min. No diagnostic `console.log` was added; the existing code was not modified.

## Task 4 — Live task definition audit

`aws ecs describe-task-definition --task-definition ComputeStackTaskDefCD5729AC:10`:

| Field                             | Value                           |
| --------------------------------- | ------------------------------- |
| `family`                          | `ComputeStackTaskDefCD5729AC`   |
| `revision`                        | `10`                            |
| `cpu` (task)                      | `4096` (= 4 vCPU)               |
| `memory` (task)                   | `8192` (= 8 GB)                 |
| `containerDefinitions[0].cpu`     | `0` (share task CPU)            |
| `containerDefinitions[0].memory`  | not set (inherit task `memory`) |
| `runtimePlatform.cpuArchitecture` | `ARM64`                         |
| `requiresCompatibilities`         | `FARGATE`                       |

This matches the deploy-side override in `.env`: `FARGATE_CPU=4096`, `FARGATE_MEMORY=8192`. CDK code at `packages/cdk/lib/stacks/compute-stack.ts:69-70` (`memoryLimitMiB: props.fargateMemory ?? 2048`, `cpu: props.fargateCpu ?? 1024`) is not wrong — the env-provided values win, which is the intended behavior wired in `packages/cdk/bin/app.ts:49-50`.

Explaining the "4 vCPU / 16 GB" reading from inside the container:

- **4 vCPU is correct** — the Fargate cgroup exposes 4 CPUs because `cpu=4096` on the task. `os.cpus().length` will return 4.
- **16 GB is the host view**, not the task cap. Fargate (platform `1.4.0`) uses a shared underlying host and sets a cgroup memory limit at the task level. `os.totalmem()` in Node.js reads `/proc/meminfo`, which reports host memory and is not clamped by the cgroup. The actual task cap is 8 GB, which would be visible in `/sys/fs/cgroup/memory.max` (cgroup v2) or `/sys/fs/cgroup/memory/memory.limit_in_bytes` (v1). This was not verified against a running task because no tasks were running at investigation time, but the gap between Node's `os.totalmem()` and the Fargate cgroup cap is a well-known, expected reading — no misconfiguration.

Action required on sizing: **none**. The deployed task is 4 vCPU / 8 GB as requested via `.env`. The CDK defaults (1 vCPU / 2 GB) are only relevant if `FARGATE_CPU` / `FARGATE_MEMORY` are unset.

## Root cause and applied fix

The initial investigation flagged sparse CloudWatch history as the trigger for the `INACTIVE_TIMEOUT_MS = 10 min` branch firing. That was true, but a follow-up pass found a deeper bug: the gateway's `routeFargate` happy path (task already `Running` with a `publicIp`) calls `sendToBridge(...)` and returns `"sent"` without writing `lastActivity` back to DynamoDB. Prior to the fix, `lastActivity` was only advanced in three places — task start (`packages/gateway/src/services/message.ts:157`), prewarm claim (`:124`), and the lambda-agent path — none of which fire during a normal active conversation hitting an already-running container.

Evidence from `/aws/lambda/serverless-openclaw-telegram-webhook` for the 08:00–08:20 UTC window on 2026-04-22:

- Task `3cb07c3e` was alive from 08:04:23 to 08:17:49 UTC.
- Telegram webhook received **8 inbound messages** between 08:08:19 and 08:14:13 UTC for the same user.
- None of those messages advanced `lastActivity` in DynamoDB — the task took the "Running + publicIp" branch every time and skipped the `putTaskState` write.
- At 08:17:49 UTC the watchdog scanned, computed `inactiveMs` against a `lastActivity` pinned to the task's start time, and killed the task under the 10-min inactive branch.

Applied fix: add a `putTaskState({ ...taskState, lastActivity: new Date().toISOString() })` call right after the successful `sendToBridge` in `packages/gateway/src/services/message.ts`. This is the minimum change that makes the watchdog see real activity.

The timeout defaults were also raised (30 min for both `INACTIVE_TIMEOUT_MS` and `INACTIVITY_TIMEOUT_MS`) as a belt-and-braces measure so that a single CloudWatch misclassification or `lastActivity` write failure produces a 30-minute grace window instead of 10–15.

Deferred follow-ups (not applied, not currently needed):

- **Container-side heartbeat for very long agent turns**: would only matter for a single user message that takes > 30 min of tool calls to answer with no follow-up message in the meantime.
- **`ConsistentRead: true` on the watchdog scan**: adds at most a few seconds of correctness to the read — orthogonal to the bug that caused the kills observed here.
- **Warn-log on the silent `catch {}` in `getActiveTimeout()`**: nice-to-have for future CloudWatch debugging; not causal in these incidents.

Do X next: deploy the `ApiStack` (houses the gateway Lambda and the watchdog) and monitor for another week of normal usage. If a single message that takes > 30 min to answer ever triggers a mid-turn kill, revisit the heartbeat.

## Post-deploy verification

`ApiStack` deployed 2026-04-22 at ~11:40 UTC+2. All 7 Lambdas updated; watchdog `CodeSha256` changed from `CEAJAoe0ZGxqsOyL4q8rcfgO4a7qvHlCpntGIuU1oaU=` to `5tcVBVOHeuJXX+aaxYOu3eXVSNRzn3qswGdULRRloo0=`.

Live verification, task `3f7fc447` started 11:45:13 UTC+2:

| Time (UTC) | Source                      | Observation                                                                   |
| ---------- | --------------------------- | ----------------------------------------------------------------------------- |
| 09:44:39   | telegram-webhook Lambda     | message 1 received; task-start path writes `lastActivity = startedAt`         |
| 09:47:51   | DynamoDB `TaskState`        | `status=Running`, `publicIp=52.59.231.154`, `lastActivity=startedAt=09:47:51` |
| 09:48:00   | CloudWatch `MessageLatency` | SampleCount=1, Average=200,382 ms (includes cold start)                       |
| 09:53:10   | telegram-webhook Lambda     | message 2 received; takes `Running+publicIp` branch in `routeFargate`         |
| 09:53:11   | DynamoDB `TaskState`        | **`lastActivity = 09:53:11Z` — advanced 5m20s past `startedAt`**              |
| 09:53:00   | CloudWatch `MessageLatency` | SampleCount=1, Average=9,865 ms (warm path)                                   |

The 5m20s advance of `lastActivity` past `startedAt` is only possible through the new `putTaskState` call added to `routeFargate`'s happy path. Fix confirmed live.

Unrelated pre-existing issue observed during verification: the OpenClaw container's built-in Telegram provider emits `getUpdates` 409 conflicts every 30 s because the gateway-configured webhook owns the Telegram channel. The previous (pre-deploy) task exhibited the same 31 conflicts. This is outside the scope of the watchdog fix and should be tracked separately.
