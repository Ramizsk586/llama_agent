#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/Ramizsk586/llama_agent.git"
APP_DIR="llama_agent"
BRIDGE_URL="${LLAMA_BRIDGE_URL:-http://localhost:11434}"
BRIDGE_MODEL="${LLAMA_BRIDGE_MODEL:-default}"

info() {
  printf '%s\n' "$1"
}

warn() {
  printf 'Warning: %s\n' "$1"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'ERROR: %s is required but was not found.\n' "$1" >&2
    exit 1
  fi
}

node_major() {
  node -v | sed -E 's/^v([0-9]+).*/\1/'
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local escaped
  escaped=$(printf '%s' "$value" | sed 's/[\/&]/\\&/g')
  if grep -q "^${key}=" "$file"; then
    sed -i.bak "s/^${key}=.*/${key}=${escaped}/" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

require_cmd git
require_cmd curl
require_cmd node
require_cmd npm

if [ "$(node_major)" -lt 18 ]; then
  printf 'ERROR: Node.js v18+ is required. Found %s.\n' "$(node -v)" >&2
  exit 1
fi

if ! curl -fsS "${BRIDGE_URL}/health" >/dev/null 2>&1; then
  warn "Llama Bridge does not appear to be running at ${BRIDGE_URL}."
  info "Start it first: https://github.com/Ramizsk586/llama"
fi

if [ -d "${APP_DIR}/.git" ]; then
  info "Using existing ${APP_DIR} checkout."
else
  git clone "${REPO_URL}" "${APP_DIR}"
fi

cd "${APP_DIR}"
npm install

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
  else
    : > .env
  fi
fi

set_env_value .env "LLAMA_BRIDGE_URL" "${BRIDGE_URL}"
set_env_value .env "LLAMA_BRIDGE_MODEL" "${BRIDGE_MODEL}"

existing_token=""
if grep -q "^TELEGRAM_BOT_TOKEN=" .env; then
  existing_token=$(grep "^TELEGRAM_BOT_TOKEN=" .env | tail -n 1 | cut -d= -f2-)
fi

printf '[?] Enter your Telegram bot token (leave blank to skip Telegram): '
read -r telegram_token
telegram_token="${telegram_token:-$existing_token}"
set_env_value .env "TELEGRAM_BOT_TOKEN" "${telegram_token}"

if ! curl -fsS "${BRIDGE_URL}/health" >/dev/null 2>&1; then
  warn "Llama Bridge does not appear to be running."
  info "   Start it first: https://github.com/Ramizsk586/llama"
fi

info ""
info "llama_agent installed successfully!"
info ""
info "   To start your agent:"
info "     cd ${APP_DIR}"
info "     npm start"
info ""
info "   Channels configured:"
if [ -n "${telegram_token}" ]; then
  info "     Telegram       enabled"
else
  info "     Telegram       disabled (add TELEGRAM_BOT_TOKEN to .env to enable)"
fi
info ""
info "   LLM Provider:"
info "     -> Llama Bridge at ${BRIDGE_URL}"
info ""
info "   Docs: https://github.com/Ramizsk586/llama_agent"
