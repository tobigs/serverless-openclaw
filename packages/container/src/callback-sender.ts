import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import type { ServerMessage } from "@serverless-openclaw/shared";

const TELEGRAM_MAX_LENGTH = 4096;

function stripMarkdown(text: string): string {
  return (
    text
      // Code blocks (```...```)
      .replace(/```[\s\S]*?```/g, (m) => m.slice(3, -3).trim())
      // Inline code (`...`)
      .replace(/`([^`]+)`/g, "$1")
      // Bold (**...**  or __...__)
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      // Italic (*...* or _..._)
      .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "$1")
      .replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1")
      // Strikethrough (~~...~~)
      .replace(/~~(.+?)~~/g, "$1")
      // Links [text](url) → text (url)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
      // Heading markers (# ## ### etc.)
      .replace(/^#{1,6}\s+/gm, "")
  );
}

export class CallbackSender {
  private client: ApiGatewayManagementApiClient;
  private telegramBotToken?: string;
  private telegramBuffers = new Map<string, string[]>();

  constructor(endpoint: string, telegramBotToken?: string) {
    this.client = new ApiGatewayManagementApiClient({ endpoint });
    this.telegramBotToken = telegramBotToken;
  }

  async send(connectionId: string, data: ServerMessage): Promise<void> {
    if (connectionId.startsWith("telegram")) {
      await this.handleTelegram(connectionId, data);
      return;
    }

    try {
      await this.client.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: JSON.stringify(data),
        }),
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "GoneException") {
        return;
      }
      throw err;
    }
  }

  private async handleTelegram(connectionId: string, data: ServerMessage): Promise<void> {
    if (!this.telegramBotToken) return;

    if (data.type === "stream_chunk" && data.content) {
      const buffer = this.telegramBuffers.get(connectionId) ?? [];
      buffer.push(data.content);
      this.telegramBuffers.set(connectionId, buffer);
      return;
    }

    if (data.type === "stream_end") {
      const buffer = this.telegramBuffers.get(connectionId);
      this.telegramBuffers.delete(connectionId);
      if (buffer && buffer.length > 0) {
        await this.sendTelegramMessage(connectionId, buffer.join(""));
      }
      return;
    }

    if (data.type === "error") {
      this.telegramBuffers.delete(connectionId);
      const text = data.error ?? data.content ?? "An error occurred";
      await this.sendTelegramMessage(connectionId, text);
      return;
    }
  }

  private async sendTelegramMessage(connectionId: string, text: string): Promise<void> {
    const chatId = connectionId.slice(connectionId.indexOf(":") + 1);
    const plain = stripMarkdown(text);
    try {
      for (let i = 0; i < plain.length; i += TELEGRAM_MAX_LENGTH) {
        const chunk = plain.slice(i, i + TELEGRAM_MAX_LENGTH);
        const resp = await fetch(
          `https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: chunk }),
          },
        );
        if (!resp.ok) {
          console.error(`[callback] Telegram API error ${resp.status} for ${connectionId}`);
        }
      }
    } catch (err) {
      console.error(`[callback] Failed to send Telegram message to ${connectionId}:`, err);
    }
  }
}
