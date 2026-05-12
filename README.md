# Llama Agent

Telegram-first personal agent powered by [Llama Bridge](https://github.com/Ramizsk586/llama).

Llama Agent routes every LLM request through your local Llama Bridge, keeps memory in Convex, and can use connected integrations through Composio. The chat channel is Telegram only.

## Quickstart

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure the project:

   ```bash
   npm run setup
   ```

3. Start Llama Bridge.

4. Start the agent:

   ```bash
   npm run dev
   ```

5. Message your Telegram bot.

## Required Environment

```env
LLAMA_BRIDGE_URL=http://127.0.0.1:8089
LLAMA_BRIDGE_MODEL=default
TELEGRAM_BOT_TOKEN=
PORT=3456
```

Optional proactive notices, such as surfaced Gmail alerts, use:

```env
TELEGRAM_NOTIFY_CHAT_ID=
```

## Commands

```bash
npm run setup        # interactive setup
npm run dev          # server + Convex + debug dashboard
npm start            # production-style server start
npm run typecheck    # TypeScript check
```

## HTTP Endpoints

- `GET /health`
- `POST /chat`
- `POST /composio/webhook`
- `GET /ws`

## Notes

- Telegram polling starts automatically when `TELEGRAM_BOT_TOKEN` is set.
- Llama Bridge must be reachable at `LLAMA_BRIDGE_URL`.
- Convex generated files are required before startup. Run `npx convex dev --once` if `convex/_generated/api.js` is missing.
- Composio is optional and enables integrations such as Gmail, Slack, GitHub, Linear, and Notion.
