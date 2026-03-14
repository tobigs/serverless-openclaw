# User Guide — Quick Start

This guide helps end users get started with Serverless OpenClaw after the system has been deployed. You can interact with the AI agent via the **Web UI** or **Telegram**.

---

## Prerequisites

You need the following from your administrator:

| Item | Example |
|------|---------|
| Web UI URL | `https://d1234abcdef.cloudfront.net` |
| Telegram Bot name (optional) | `@MyOpenClawBot` |

---

## Option A: Web UI

### 1. Create an Account

1. Open the Web UI URL in your browser
2. Click **Sign Up**
3. Enter your email and a password (minimum 8 characters)
4. Check your email for a 6-digit verification code
5. Enter the code and click **Verify**
6. You will be signed in automatically

### 2. Start Chatting

1. After signing in, you will see the chat interface
2. Type a message and press Enter (or click Send)
3. On your first message, the agent status will show **"Waking up agent..."** — this is the cold start and typically takes 30-60 seconds
4. Once the status changes to **"Running"**, the agent will respond to your message
5. Continue the conversation as needed

### 3. Agent Status Indicators

| Status | Meaning |
|--------|---------|
| **Idle** | No agent running. Your next message will start one |
| **Starting** | Agent container is booting up (cold start). Messages are queued and will be delivered automatically |
| **Running** | Agent is active and responding |
| **Stopping** | Agent is shutting down after inactivity |

### 4. Sign Out

Click the **Logout** button in the top-right corner of the chat interface.

---

## Option B: Telegram

### 1. Find the Bot

1. Open Telegram and search for the bot name provided by your administrator
2. Start a conversation by sending `/start` or any message

### 2. Start Chatting

1. Send any text message to the bot
2. If the agent is not running, you will receive a reply: "Waking up agent... please wait a moment."
3. After 30-60 seconds, the agent will respond to your message
4. Continue the conversation normally

---

## Tips

- **Cold start delay**: The first message after a period of inactivity may trigger a startup delay. With Lambda runtime (default): ~1-2 seconds. With Fargate runtime: ~40-60 seconds (first-time container startup). Subsequent messages are instant while the agent is running.
- **Predictive pre-warming**: If your administrator has enabled pre-warming, the agent container starts automatically at scheduled times (e.g., the start of your work hours). During pre-warmed periods, your first message gets an **instant response** with no cold start delay.
- **Auto shutdown**: The agent automatically shuts down after a period of inactivity to minimize costs. Your next message will wake it up again.
- **Message queuing**: Messages sent during cold start are not lost. They are queued and delivered to the agent once it is ready.
- **Multiple interfaces**: You can use both Web UI and Telegram. They connect to the same agent but maintain separate conversation contexts.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Waking up agent..." but no response after 2 minutes | The container may have failed to start. Try sending another message. If it persists, contact your administrator |
| Cannot sign up (Web UI) | Ensure your password is at least 8 characters and contains uppercase, lowercase, and a number |
| Verification code not received | Check your spam folder. The email is sent from AWS Cognito (no-reply@verificationemail.com) |
| Web UI shows "Offline" | Your WebSocket connection was lost. Refresh the page to reconnect |
| Telegram bot not responding at all | The webhook may not be configured. Contact your administrator |
