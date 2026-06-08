import * as net from "net";

export function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function tryConnect(): void {
      const sock = net.createConnection({ port, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`));
        } else {
          setTimeout(tryConnect, 500);
        }
      });
    }
    tryConnect();
  });
}

export async function notifyTelegram(
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {
    // Non-fatal — startup notifications are best-effort
  }
}

export function getTelegramChatId(userId: string): string | null {
  // Matches "telegram:{id}" and "telegram-{botId}:{id}"
  if (!userId.startsWith("telegram")) return null;
  const colonIdx = userId.indexOf(":");
  return colonIdx !== -1 ? userId.slice(colonIdx + 1) : null;
}
