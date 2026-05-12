# Changelog

## Telegram-Only Cleanup

- Removed the previous non-Telegram chat channel.
- Removed the old webhook, scripts, Convex dedup table, setup prompts, package scripts, and runtime imports.
- Kept Telegram as the only chat channel.
- Added optional `TELEGRAM_NOTIFY_CHAT_ID` for proactive Telegram notices.
- Updated setup and dev scripts to describe Telegram-only operation.
