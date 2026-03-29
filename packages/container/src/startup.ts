import { BRIDGE_PORT } from "@serverless-openclaw/shared";
import { createApp } from "./bridge.js";
import { CallbackSender } from "./callback-sender.js";
import { OpenClawClient } from "./openclaw-client.js";
import { LifecycleManager } from "./lifecycle.js";
import { consumePendingMessages } from "./pending-messages.js";
import { restoreFromS3 } from "./s3-sync.js";
import { discoverPublicIp } from "./discover-public-ip.js";
import {
  saveMessagePair,
  loadRecentHistory,
  formatHistoryContext,
} from "./conversation-store.js";
import type { PendingMessageItem, Channel } from "@serverless-openclaw/shared";
import { publishStartupMetrics, publishMessageMetrics } from "./metrics.js";
import { waitForPort, notifyTelegram, getTelegramChatId } from "./utils.js";

type Send = (command: unknown) => Promise<unknown>;

export interface StartContainerOptions {
  env: {
    BRIDGE_AUTH_TOKEN: string;
    OPENCLAW_GATEWAY_TOKEN: string;
    USER_ID: string;
    DATA_BUCKET: string;
    CALLBACK_URL: string;
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_CHAT_ID?: string;
  };
  taskMetadata: { taskArn: string; cluster: string };
  dynamoSend: Send;
  ecsSend: Send;
  ec2Send: Send;
}

export async function startContainer(opts: StartContainerOptions): Promise<void> {
  const t0 = Date.now();
  const { env, taskMetadata, dynamoSend, ecsSend, ec2Send } = opts;
  const { taskArn, cluster } = taskMetadata;
  const userId = env.USER_ID;
  const telegramChatId = env.TELEGRAM_CHAT_ID ?? getTelegramChatId(userId);
  const channel: Channel = telegramChatId ? "telegram" : "web";
  const gatewayUrl = `ws://localhost:${18789}`;

  // Phase 1: Parallel — S3 restore and history load are independent
  const [, history] = await Promise.all([
    restoreFromS3({
      bucket: env.DATA_BUCKET,
      prefix: `workspaces/${userId}`,
      localPath: "/data/workspace",
    }),
    loadRecentHistory(dynamoSend, userId),
  ]);
  const tS3 = Date.now();

  let historyPrefix = formatHistoryContext(history);
  if (historyPrefix) {
    console.log(`Loaded ${history.length} previous messages for context`);
  }

  // Telegram startup notification (best-effort, non-blocking)
  if (telegramChatId && env.TELEGRAM_BOT_TOKEN) {
    void notifyTelegram(
      env.TELEGRAM_BOT_TOKEN,
      telegramChatId,
      "⚡ Container started. Connecting to AI engine...",
    );
  }

  // Phase 2: Sequential — wait for gateway, then client
  await waitForPort(18789, 120000);
  const tGateway = Date.now();

  const telegramBotToken = env.TELEGRAM_BOT_TOKEN;
  const callbackSender = new CallbackSender(env.CALLBACK_URL, telegramBotToken);
  const openclawClient = new OpenClawClient(gatewayUrl, env.OPENCLAW_GATEWAY_TOKEN);
  await openclawClient.waitForReady();
  const tClient = Date.now();

  if (telegramChatId && env.TELEGRAM_BOT_TOKEN) {
    void notifyTelegram(
      env.TELEGRAM_BOT_TOKEN,
      telegramChatId,
      "✅ Ready! Processing messages...",
    );
  }

  const lifecycle = new LifecycleManager({
    dynamoSend,
    userId,
    taskArn,
    s3Bucket: env.DATA_BUCKET,
    s3Prefix: `workspaces/${userId}`,
    workspacePath: "/data/workspace",
  });

  // Phase 3: Bridge server start
  const app = createApp({
    authToken: env.BRIDGE_AUTH_TOKEN,
    openclawClient,
    callbackSender,
    lifecycle,
    processStartTime: t0,
    channel,
    onMessageComplete: async (uid: string, userMsg: string, assistantMsg: string, ch: Channel) => {
      await saveMessagePair(dynamoSend, uid, userMsg, assistantMsg, ch);
    },
    getAndClearHistoryPrefix: () => {
      const prefix = historyPrefix;
      historyPrefix = "";
      return prefix;
    },
  });

  const server = app.listen(BRIDGE_PORT, "0.0.0.0", () => {
    console.log(`Bridge server listening on port ${BRIDGE_PORT}`);
  });

  // Update state to Running immediately (without IP — IP discovered in background)
  await lifecycle.updateTaskState("Running");

  // Phase 4: IP discovery — fire-and-forget (non-blocking)
  void (async () => {
    try {
      const publicIp = await discoverPublicIp(ecsSend, ec2Send, cluster, taskArn);
      console.log(`Public IP: ${publicIp ?? "not available"}`);
      if (publicIp) {
        await lifecycle.updateTaskState("Running", publicIp);
      }
    } catch (err) {
      console.warn("IP discovery failed (non-fatal):", err);
    }
  })();

  // Phase 5: Consume pending messages
  const consumed = await consumePendingMessages({
    dynamoSend,
    userId,
    processMessage: async (msg: PendingMessageItem) => {
      const msgStart = new Date(msg.createdAt).getTime();

      const messageToSend = historyPrefix
        ? historyPrefix + msg.message
        : msg.message;
      historyPrefix = "";

      const generator = openclawClient.sendMessage(userId, messageToSend);
      let fullResponse = "";
      for await (const chunk of generator) {
        fullResponse += chunk;
        await callbackSender.send(msg.connectionId, {
          type: "stream_chunk",
          content: chunk,
        });
      }
      await callbackSender.send(msg.connectionId, {
        type: "stream_end",
      });

      void publishMessageMetrics({
        latency: Date.now() - msgStart,
        responseLength: fullResponse.length,
        channel: msg.channel,
      });

      if (fullResponse) {
        await saveMessagePair(dynamoSend, userId, msg.message, fullResponse, msg.channel).catch(() => {});
      }
    },
  });

  if (consumed > 0) {
    console.log(`Processed ${consumed} pending message(s)`);
  }

  const tRunning = Date.now();
  console.log(`Startup complete in ${tRunning - t0}ms (S3+History: ${tS3 - t0}ms, Gateway: ${tGateway - tS3}ms, Client: ${tClient - tGateway}ms)`);

  void publishStartupMetrics({
    total: tRunning - t0,
    s3Restore: tS3 - t0,
    gatewayWait: tGateway - tS3,
    clientReady: tClient - tGateway,
    pendingMessages: consumed,
    userId,
    channel,
  });

  lifecycle.startPeriodicBackup();

  // SIGTERM handler
  process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down gracefully...");
    server.close(async () => {
      await lifecycle.gracefulShutdown();
      openclawClient.close();
      process.exit(0);
    });
  });

}
