declare module "node-telegram-bot-api" {
  export default class TelegramBot {
    constructor(token: string, options: { polling: boolean });
    on(event: "message", listener: (message: {
      chat: { id: number | string };
      text?: string;
      message_id?: number;
    }) => void | Promise<void>): void;
    on(event: "polling_error", listener: (error: Error) => void): void;
    sendMessage(chatId: number | string, text: string): Promise<unknown>;
  }
}
