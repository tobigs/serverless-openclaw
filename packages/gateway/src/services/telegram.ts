type FetchFn = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

export async function sendTelegramMessage(
  fetchFn: FetchFn,
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  // Strip "telegram[...]:NNN" prefix if present (connectionId format)
  const colonIdx = chatId.indexOf(":");
  const resolvedChatId = colonIdx !== -1 ? chatId.slice(colonIdx + 1) : chatId;

  try {
    await fetchFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: resolvedChatId, text }),
    });
  } catch {
    // Fire-and-forget: log but don't throw
  }
}
