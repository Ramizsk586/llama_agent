const TELEGRAM_MESSAGE_LIMIT = 3900;

export async function sendTelegramToConversation(conversationId: string, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = telegramChatIdFromConversation(conversationId);
  if (!token || !chatId) return false;

  for (const part of splitTelegramText(text)) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: part }),
    });
    if (!response.ok) {
      throw new Error(`telegram send failed ${response.status}: ${await response.text()}`);
    }
  }
  return true;
}

function telegramChatIdFromConversation(conversationId: string): string | null {
  const match = conversationId.match(/^telegram:(.+)$/);
  return match?.[1]?.trim() || null;
}

function splitTelegramText(text: string): string[] {
  const normalized = text.trim() || "(no output)";
  if (normalized.length <= TELEGRAM_MESSAGE_LIMIT) return [normalized];

  const parts: string[] = [];
  let remaining = normalized;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    const window = remaining.slice(0, TELEGRAM_MESSAGE_LIMIT);
    const splitAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const cut = splitAt > TELEGRAM_MESSAGE_LIMIT * 0.6 ? splitAt : TELEGRAM_MESSAGE_LIMIT;
    parts.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}
