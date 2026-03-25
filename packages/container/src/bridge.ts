import express from "express";
import { createAuthMiddleware } from "./auth-middleware.js";
import { publishMessageMetrics, publishFirstResponseTime } from "./metrics.js";
import type { BridgeMessageRequest, ServerMessage, Channel } from "@serverless-openclaw/shared";

export interface BridgeDeps {
  authToken: string;
  openclawClient: {
    sendMessage(userId: string, message: string): AsyncGenerator<string>;
    close(): void;
  };
  callbackSender: {
    send(connectionId: string, data: ServerMessage): Promise<void>;
  };
  lifecycle: {
    updateTaskState(status: string, publicIp?: string): Promise<void>;
    gracefulShutdown(): Promise<void>;
    updateLastActivity(): void;
    lastActivityTime: Date;
  };
  processStartTime: number;
  channel: string;
  onMessageComplete?: (userId: string, userMsg: string, assistantMsg: string, channel: Channel) => Promise<void>;
  getAndClearHistoryPrefix?: () => string;
}

const startTime = Date.now();

export function createApp(deps: BridgeDeps): express.Express {
  const app = express();
  let firstResponseSent = false;

  app.use(express.json());
  app.use(createAuthMiddleware(deps.authToken));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/message", (req, res) => {
    const body = req.body as Partial<BridgeMessageRequest>;

    if (!body.userId || !body.message || !body.channel || !body.connectionId || !body.callbackUrl) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    deps.lifecycle.updateLastActivity();

    // Respond immediately, process asynchronously
    res.status(202).json({ status: "processing" });

    // Fire-and-forget async processing
    void (async () => {
      const msgStart = Date.now();
      try {
        let prefix = deps.getAndClearHistoryPrefix?.() ?? "";
        if (body.channel === "telegram") {
          prefix += "[System: Respond in plain text only. Do not use markdown formatting such as **bold**, *italic*, ```code```, etc.]\n";
        }
        const messageToSend = prefix ? prefix + body.message! : body.message!;
        const generator = deps.openclawClient.sendMessage(
          body.userId!,
          messageToSend,
        );
        let fullResponse = "";
        for await (const chunk of generator) {
          fullResponse += chunk;
          await deps.callbackSender.send(body.connectionId!, {
            type: "stream_chunk",
            content: chunk,
            conversationId: undefined,
          });
        }
        await deps.callbackSender.send(body.connectionId!, {
          type: "stream_end",
        });

        // Publish message metrics
        const latency = Date.now() - msgStart;
        void publishMessageMetrics({
          latency,
          responseLength: fullResponse.length,
          channel: deps.channel,
        });

        if (!firstResponseSent) {
          firstResponseSent = true;
          void publishFirstResponseTime(Date.now() - deps.processStartTime, deps.channel);
        }

        // Save conversation to DynamoDB
        if (deps.onMessageComplete && fullResponse) {
          await deps.onMessageComplete(
            body.userId!,
            body.message!,
            fullResponse,
            body.channel! as "web" | "telegram",
          ).catch(() => {});
        }
      } catch (err) {
        await deps.callbackSender.send(body.connectionId!, {
          type: "error",
          error: err instanceof Error ? err.message : "Unknown error",
        }).catch(() => {});
      }
    })();
  });

  app.get("/status", (_req, res) => {
    res.json({
      status: "running",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      lastActivity: deps.lifecycle.lastActivityTime.toISOString(),
    });
  });

  app.post("/shutdown", (_req, res) => {
    res.json({ status: "shutting_down" });
    void deps.lifecycle.gracefulShutdown();
  });

  return app;
}
