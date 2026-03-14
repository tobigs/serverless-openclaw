---
name: release
description: Runs a comprehensive release review before tagging and publishing a new version. Executes 6 parallel review lanes (code, docs, tests, security, cost, operations) and blocks release until all pass. Use when preparing a release or before creating a git tag.
argument-hint: "[version, e.g. v0.3.0]"
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent
---

# Release Review & Publish

Target version: **$ARGUMENTS**

## Procedure

Run all 6 review lanes **in parallel** using the Agent tool, then aggregate results. Block release if any lane rejects.

### Step 1: Pre-flight Checks

Before launching reviews, verify basics:

```bash
npm run build      # TypeScript compilation
npm run lint       # ESLint
npm run test       # Unit tests (233+)
npm run test:e2e   # E2E tests (35+)
```

All must pass before proceeding.

### Step 2: Parallel Review Lanes (6 agents)

Launch all 6 agents simultaneously. Each agent returns APPROVE or REJECT with findings.

#### Lane 1: Code Review

```
Agent(subagent_type="oh-my-claudecode:code-reviewer", model="opus")
```

Scope: `git diff v{previous-tag}...HEAD` — all code changes since last release.

Checklist:
- No debug code, console.log, TODO/FIXME left behind
- Error handling is complete (no silent catches)
- Types are correct (no `any` without justification)
- No hardcoded secrets, credentials, or API keys
- Import paths use `.js` extension
- DI patterns followed (send function injection)
- No backward-incompatible changes without documentation

#### Lane 2: Documentation Review

```
Agent(subagent_type="oh-my-claudecode:code-reviewer", model="sonnet")
```

Scope: All files in `docs/`, `README.md`, `CLAUDE.md`, `RELEASE_NOTES.md`

Checklist:
- All docs written in English (project rule)
- Architecture diagrams match current code (stack count, data flows)
- Test counts match actual (`npm run test` output vs documented numbers)
- Package count matches actual (`ls packages/`)
- No broken links (check relative paths)
- RELEASE_NOTES.md has entry for target version
- Phase status in progress.md is accurate

#### Lane 3: Test Coverage Review

```
Agent(subagent_type="oh-my-claudecode:test-engineer", model="sonnet")
```

Scope: All test files in `packages/*/\__tests__/`

Checklist:
- All new source files have corresponding test files
- No skipped tests (`.skip`, `.todo`)
- Mock patterns are correct (`vi.hoisted()` for cross-module)
- Edge cases covered (error paths, empty inputs, concurrent access)
- E2E tests cover all CDK stacks
- No flaky tests (time-dependent, order-dependent)

#### Lane 4: Security Review

```
Agent(subagent_type="oh-my-claudecode:security-reviewer", model="sonnet")
```

Scope: All source code + CDK stacks + Dockerfile

Checklist — reference `docs/architecture.md` security sections:
- No secrets in code, config files, or Docker layers
- IAM policies follow least privilege (no `Resource: "*"` except CloudWatch/EC2 describe)
- DynamoDB conditional writes for concurrency (SessionLock)
- Bridge Bearer token required on all endpoints except `/health`
- Server-side userId only (IDOR prevention)
- No `launchType` in RunTask (use `capacityProviderStrategy`)
- Lambda env vars: no secrets in plaintext (SSM paths only)
- Dockerfile: non-root user, no secrets baked in

#### Lane 5: Cost Optimization Review

```
Agent(subagent_type="oh-my-claudecode:code-reviewer", model="sonnet")
```

Scope: CDK stacks in `packages/cdk/lib/stacks/`

Checklist — reference `docs/cost-optimization.md`:
- No NAT Gateway (`natGateways: 0`)
- No ALB or Interface VPC Endpoints
- DynamoDB PAY_PER_REQUEST (no provisioned mode)
- Lambda outside VPC (no ENI costs)
- S3 lifecycle rules for session cleanup
- ECR lifecycle rules (keep last N images)
- No resources that incur idle charges when `AGENT_RUNTIME=lambda`
- CloudWatch log retention ≤ 1 week
- Fargate Spot (not On-Demand) when Fargate is used

#### Lane 6: Operations Review

```
Agent(subagent_type="oh-my-claudecode:code-reviewer", model="sonnet")
```

Scope: Monitoring, dashboards, deployment, runbook

Checklist:
- MonitoringStack dashboard exists and covers key metrics
- CloudWatch alarms or log-based alerts for critical failures
- Watchdog Lambda detects stuck tasks (Fargate + Lambda)
- SessionLock TTL prevents permanent locks (15 min)
- `AGENT_RUNTIME` feature flag documented and tested in all modes
- Deployment guide covers rollback procedure
- `make` targets work (`task-status`, `task-stop`, `deploy-web`)
- Health check endpoints functional (`/health` for Bridge)

### Step 3: Aggregate Results

After all 6 agents complete:

```
| Lane         | Verdict  | Critical | High | Medium | Low |
|--------------|----------|----------|------|--------|-----|
| Code         | APPROVE  |    0     |  0   |   1    |  2  |
| Docs         | APPROVE  |    0     |  0   |   0    |  0  |
| Tests        | APPROVE  |    0     |  0   |   0    |  1  |
| Security     | APPROVE  |    0     |  0   |   0    |  0  |
| Cost         | APPROVE  |    0     |  0   |   0    |  0  |
| Operations   | APPROVE  |    0     |  1   |   0    |  0  |
```

**Release decision:**
- All APPROVE + 0 Critical + 0 High → **proceed with release**
- Any REJECT or Critical/High issues → **fix before release**

### Step 4: Publish (only if all lanes approve)

```bash
# 1. Update version in RELEASE_NOTES.md (should already be done)
# 2. Commit any last fixes
git add -A && git commit -m "chore: prepare release $ARGUMENTS"

# 3. Push
git push origin main

# 4. Create GitHub release
gh release create $ARGUMENTS --title "$ARGUMENTS — [title]" --notes-file RELEASE_NOTES.md --target main
```

### Step 5: Post-Release

- Close any related GitHub issues
- Update `docs/progress.md` if needed
- Notify stakeholders (social media post template available)

## References

- [Deployment Guide](../../../docs/deployment.md)
- [Cost Optimization](../../../docs/cost-optimization.md)
- [Architecture](../../../docs/architecture.md)
- [Security Model](../../../docs/architecture.md#7-security-model)
- [Progress](../../../docs/progress.md)
- [Release Notes](../../../RELEASE_NOTES.md)
