import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { handleUserMessage } from "../interaction-agent.js";
import { broadcast } from "../broadcast.js";

type TelegramBotConstructor = new (
  token: string,
  options: { polling: boolean },
) => TelegramBot;

interface TelegramMessage {
  chat: { id: number | string };
  text?: string;
  message_id?: number;
}

interface TelegramBot {
  on(event: "message", listener: (message: TelegramMessage) => void | Promise<void>): void;
  on(event: "polling_error", listener: (error: Error) => void): void;
  sendMessage(chatId: number | string, text: string): Promise<unknown>;
  sendChatAction(chatId: number | string, action: "typing"): Promise<unknown>;
}

let botStarted = false;

export async function startTelegram(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || botStarted) return;

  const module = await import("node-telegram-bot-api");
  const TelegramBot = (module.default ?? module) as TelegramBotConstructor;
  const bot = new TelegramBot(token, { polling: true });
  botStarted = true;

  bot.on("message", async (message) => {
    const chatId = message.chat?.id;
    const content = message.text?.trim();
    if (!chatId || !content) return;

    const conversationId = `telegram:${chatId}`;
    const turnTag = Math.random().toString(36).slice(2, 8);
    const preview = content.length > 100 ? content.slice(0, 100) + "..." : content;
    console.log(`[turn ${turnTag}] <- telegram:${chatId}: ${JSON.stringify(preview)}`);
    broadcast("message_in", {
      conversationId,
      content,
      telegram_chat_id: chatId,
      handle: message.message_id,
    });

    const typing = startTyping(bot, chatId);
    try {
      const reply = await handleUserMessage({
        conversationId,
        content,
        turnTag,
        onThinking: (t) => broadcast("thinking", { conversationId, t }),
      });
      if (!reply) return;
      typing.stop();
      await bot.sendMessage(chatId, reply);
      await convex.mutation(api.messages.send, {
        conversationId,
        role: "assistant",
        content: reply,
      });
      console.log(`[turn ${turnTag}] -> telegram reply (${reply.length} chars)`);
    } catch (err) {
      console.error(`[turn ${turnTag}] telegram handler error`, err);
      typing.stop();
      await bot.sendMessage(chatId, "Sorry - I hit an error processing that. Try again in a moment.");
    } finally {
      typing.stop();
    }
  });

  bot.on("polling_error", (error) => {
    console.error("[telegram] polling error", error);
  });

  console.log("[telegram] polling enabled");
}

function startTyping(bot: TelegramBot, chatId: number | string): { stop: () => void } {
  let stopped = false;
  const send = () => {
    if (stopped) return;
    bot.sendChatAction(chatId, "typing").catch(() => {
      /* ignore transient Telegram typing failures */
    });
  };

  send();
  const interval = setInterval(send, 4000);
  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}
