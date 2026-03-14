# Smart Routing Design

> Task-based Lambda/Fargate hybrid execution for `AGENT_RUNTIME=both`

## Problem

Lambda is fast (1.35s cold start) and cheap ($0 idle), but has limitations (15min timeout, /tmp workspace, no plugins). Fargate has full OpenClaw capabilities but costs ~$15/month idle. Currently `AGENT_RUNTIME=both` deploys both but routing is static — always one or the other.

## Solution

When `AGENT_RUNTIME=both`, `routeMessage` uses `classifyRoute()` to dynamically choose the optimal runtime for each request.

## Routing Rules (Priority Order)

```
1. Fargate container already Running with publicIp? → Fargate (reuse, don't waste)
2. User hint (/heavy, /fargate) in message? → Fargate (explicit request)
3. Default → Lambda (fast, cheap)
4. Lambda fails/times out → Fargate fallback (auto-retry)
```

### Rule Details

**Rule 1: Fargate Reuse**
If a Fargate container is already running for this user (TaskState status=Running, publicIp set), route to it. The container is already paid for — sending to Lambda would waste the running Fargate instance.

**Rule 2: User Hints**
Messages starting with `/heavy` or `/fargate` explicitly request the full Fargate runtime. Strip the prefix before forwarding the actual message.

**Rule 3: Lambda Default**
All other messages go to Lambda. Fast cold start, zero idle cost, sufficient for conversational AI.

**Rule 4: Timeout Fallback**
If Lambda invocation fails (error, timeout, or `success: false`), automatically fall through to the existing Fargate path: save to PendingMessages + start a new Fargate task.

## Architecture

```
routeMessage(deps)
  │
  ├─ AGENT_RUNTIME=fargate → existing Fargate path (unchanged)
  ├─ AGENT_RUNTIME=lambda  → Lambda path (unchanged)
  └─ AGENT_RUNTIME=both    → classifyRoute()
       │
       ├─ TaskState Running + publicIp? → sendToBridge (Fargate reuse)
       ├─ message starts with /heavy?   → PendingMessages + RunTask (Fargate)
       └─ default                       → invokeLambdaAgent
            │
            ├─ success → return "lambda"
            └─ error   → PendingMessages + RunTask (Fargate fallback)
```

## Interface

```typescript
// packages/gateway/src/services/route-classifier.ts

type RouteDecision = "lambda" | "fargate-reuse" | "fargate-new";

interface ClassifyRouteParams {
  message: string;
  taskState: TaskStateItem | null;
}

function classifyRoute(params: ClassifyRouteParams): RouteDecision;
```

## Message Hint Syntax

| Prefix | Effect | Example |
|--------|--------|---------|
| `/heavy` | Route to Fargate | `/heavy analyze this large codebase` |
| `/fargate` | Route to Fargate | `/fargate run the full test suite` |

The prefix is stripped before the message is forwarded to the agent.

## Fallback Flow

```typescript
// In routeMessage, when AGENT_RUNTIME=both and classifyRoute returns "lambda":
try {
  const response = await invokeLambdaAgent({ ... });
  if (!response.success) throw new Error(response.error);
  return "lambda";
} catch {
  // Lambda failed — fall through to Fargate path
  // Save to PendingMessages + RunTask (existing code)
}
```

## Cost Impact

| Scenario | Before (static) | After (smart) |
|----------|-----------------|---------------|
| Simple chat, no Fargate running | Lambda ($0) | Lambda ($0) |
| Simple chat, Fargate already running | Lambda ($0) + Fargate wasted | **Fargate (reuse)** |
| Complex task, user knows upfront | Lambda (may fail) | **Fargate (user hint)** |
| Lambda timeout | Error returned to user | **Fargate (auto-fallback)** |
