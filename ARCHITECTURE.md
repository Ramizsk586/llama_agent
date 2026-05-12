# Architecture

Llama Agent is a Telegram-only personal agent backed by Llama Bridge.

## Flow

```text
Telegram polling
  -> server/channels/telegram.ts
  -> Interaction Agent
  -> optional Execution Agents
  -> Llama Bridge
```

## Main Pieces

- `server/index.ts` starts Express, WebSocket events, Telegram polling, memory cleanup, automations, heartbeat, consolidation, and integration loading.
- `server/channels/telegram.ts` receives Telegram messages and sends replies.
- `server/interaction-agent.ts` is the dispatcher. It answers quick turns, writes/recalls memory, creates automations, stages drafts, and spawns execution agents for real work.
- `server/execution-agent.ts` runs focused background tasks with web and integration tools.
- `server/llm/bridge-client.ts` routes model traffic to Llama Bridge.
- `convex/schema.ts` stores conversations, messages, memory, drafts, automations, usage, and agent runs.
- `debug/` contains the local dashboard.

## Setup

Run:

```bash
npm run setup
npm run dev
```

Set `TELEGRAM_BOT_TOKEN` to enable Telegram polling.
