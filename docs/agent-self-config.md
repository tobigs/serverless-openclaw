# Agent Self-Configuration User Guide

## What This Is

OpenClaw running on Fargate can configure itself — installing MCP servers, creating skills, and
updating its own settings — and those changes persist across container restarts via S3. This
makes the agent genuinely useful rather than just a chatbot wrapper.

## Why Fargate Only

Lambda (`AGENT_RUNTIME=lambda`) is a stateless request-response function. It can't:

- Run MCP servers (requires long-lived child processes)
- Persist config changes (fresh `/tmp` on every invocation)
- Execute long-running tasks (15-minute hard limit)

If you want ChatGPT-style chat, use ChatGPT. The point of running OpenClaw on your own infra
is integrated tool use. Set `AGENT_RUNTIME=fargate` in `.env`.

## How Persistence Works

On every container startup, the following are restored from S3:

| Path                                   | S3 Prefix                 | What it contains                              |
| -------------------------------------- | ------------------------- | --------------------------------------------- |
| `/home/openclaw/.openclaw/`            | `openclaw-home/{userId}/` | Config, managed skills                        |
| `/data/workspace/`                     | `workspaces/{userId}/`    | AGENTS.md, SOUL.md, USER.md, workspace skills |
| `~/.openclaw/agents/default/sessions/` | `sessions/{userId}/...`   | Conversation history                          |

On shutdown (inactivity timeout or SIGTERM), everything is synced back to S3.

`patch-config.ts` merges system-required fields (port, secrets, AI provider) on top of the
restored config — user-owned keys like `mcpServers`, `skills`, `agents`, and `controlUi` are
preserved.

## Container Lifetime

The watchdog terminates the container after inactivity:

- Active hours (2+ days of activity at this hour in the past week): 30 minutes
- Inactive hours: 10 minutes
- Fallback: 15 minutes

The watchdog runs every 5 minutes, so add up to 5 minutes of scan delay.

Each message resets the timer. An active conversation keeps the container alive.

## User Flow

### 1. First Run — Bootstrap the Agent

Send via Telegram after first deploy:

```
Set up your workspace. Create AGENTS.md with instructions that you're my personal assistant.
Create SOUL.md with a friendly but concise personality. Create USER.md with my name [name].
```

The agent writes these files to `/data/workspace/`. They sync to S3 and are restored on every
future startup, injecting your context into every session.

### 2. Install an MCP Server

Tell the agent to configure itself:

```
Add the Trello MCP server to your config. In ~/.openclaw/openclaw.json under mcpServers,
add an entry named "trello" with command "npx", args ["-y", "trello-mcp-server"],
and env TRELLO_API_KEY=[key] and TRELLO_TOKEN=[token].
```

The agent writes to `openclaw.json`. The `mcpServers` key survives `patch-config.ts` merging.
On next startup, OpenClaw spawns the MCP server as a child process and the tools are available.

**Note on cold start:** `npx -y trello-mcp-server` downloads the package on first use per
container lifetime. For frequently used servers, bake them into the Docker image with
`npm install -g trello-mcp-server` to eliminate this overhead.

### 3. Create a Skill

```
Create a skill at ~/workspace/skills/daily-summary/SKILL.md that teaches you to check
my Trello board and summarize what's due today when I ask for a morning briefing.
```

Skills are markdown files injected into the agent's context at session start. They define
instructions and tool usage patterns — not running processes. They persist via workspace S3 sync.

### 4. Day-to-Day Use

Just message normally via Telegram:

```
What's on my Trello board today?
Move the "write blog post" card to Done.
```

Cold start on first message: ~60s. Subsequent messages while container is running: instant.

## Scheduled Tasks (Planned)

Skills can define routines, but they only run when the container is running. For tasks that
should happen on a schedule (e.g. morning briefing at 9am), a `scheduled-task` Lambda handler
is needed:

1. EventBridge cron rule fires at 9am
2. Lambda spins up Fargate task (or reuses running one)
3. Lambda sends a predefined message: "run your morning briefing routine"
4. Agent executes the skill instructions (check Trello, summarize, etc.)
5. Response delivered via Telegram

The infrastructure is mostly in place (EventBridge, Fargate task management, Telegram callback).
This is not yet implemented.

## What's Not Yet Supported

| Feature                                                      | Status                           |
| ------------------------------------------------------------ | -------------------------------- |
| Interactive tool approvals (agent asks "should I run this?") | Not implemented                  |
| Browser automation (Chromium)                                | Phase 3                          |
| Settings UI in web frontend                                  | Phase 3                          |
| Scheduled task execution                                     | Planned                          |
| Lambda config sync (Lambda sees Fargate-configured tools)    | Deprioritized — use Fargate only |
