import type { UsageTotals } from "../usage.js";

type AgentSdk = typeof import("@anthropic-ai/claude-agent-sdk");

export interface BridgeMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface BridgeChatOptions {
  model?: string;
  max_tokens?: number;
  temperature?: number;
}

export interface BridgeChatResult {
  content: string;
  usage: UsageTotals;
}

const DEFAULT_BRIDGE_URL = "http://localhost:11434";
const DEFAULT_BRIDGE_MODEL = "default";

let sdkPromise: Promise<AgentSdk> | null = null;

export function bridgeUrl(): string {
  return (process.env.LLAMA_BRIDGE_URL || DEFAULT_BRIDGE_URL).replace(/\/+$/, "");
}

export function bridgeModel(): string {
  return process.env.LLAMA_BRIDGE_MODEL || DEFAULT_BRIDGE_MODEL;
}

function bridgeAuthHeaders(): Record<string, string> {
  const token = process.env.LLAMA_BRIDGE_API_KEY?.trim();
  if (!token) return {};
  return {
    Authorization: `Bearer ${token}`,
    "x-api-key": token,
  };
}

export function configureBridgeEnvironment(): void {
  process.env.LLAMA_BRIDGE_URL ||= DEFAULT_BRIDGE_URL;
  process.env.LLAMA_BRIDGE_MODEL ||= DEFAULT_BRIDGE_MODEL;

  // The existing agent loop uses the Claude Agent SDK for MCP/tool execution.
  // Point that Anthropic-compatible client at the local Llama Bridge so no
  // request goes to Anthropic directly.
  process.env.ANTHROPIC_BASE_URL = bridgeUrl();
  process.env.ANTHROPIC_AUTH_TOKEN ||= process.env.LLAMA_BRIDGE_API_KEY || "llama-agent";
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ||= bridgeModel();
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ||= bridgeModel();
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ||= bridgeModel();
}

export async function ensureBridgeReachable(): Promise<void> {
  configureBridgeEnvironment();
  const url = bridgeUrl();
  let response: Response;
  try {
    response = await fetch(`${url}/health`, { headers: bridgeAuthHeaders() });
  } catch (err) {
    throw new Error(
      `ERROR: Cannot reach Llama Bridge at LLAMA_BRIDGE_URL. Is llama running? See https://github.com/Ramizsk586/llama\n${String(err)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `ERROR: Cannot reach Llama Bridge at LLAMA_BRIDGE_URL. Is llama running? See https://github.com/Ramizsk586/llama`,
    );
  }
}

export async function chat(
  messages: BridgeMessage[],
  options: BridgeChatOptions = {},
): Promise<string> {
  const result = await chatWithUsage(messages, options);
  return result.content;
}

export async function chatWithUsage(
  messages: BridgeMessage[],
  options: BridgeChatOptions = {},
): Promise<BridgeChatResult> {
  configureBridgeEnvironment();
  const response = await fetch(`${bridgeUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...bridgeAuthHeaders(),
    },
    body: JSON.stringify({
      model: options.model || bridgeModel(),
      messages,
      ...options,
    }),
  });

  if (!response.ok) {
    throw new Error(`Llama Bridge error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string; content?: string }> } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  const content = extractContent(data.choices?.[0]?.message?.content);
  return {
    content,
    usage: {
      model: options.model || bridgeModel(),
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    },
  };
}

export async function* query(...args: Parameters<AgentSdk["query"]>) {
  configureBridgeEnvironment();
  sdkPromise ??= import("@anthropic-ai/claude-agent-sdk");
  const sdk = await sdkPromise;
  yield* sdk.query(...args);
}

function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as { text?: unknown; content?: unknown };
      return typeof item.text === "string"
        ? item.text
        : typeof item.content === "string"
          ? item.content
          : "";
    })
    .filter(Boolean)
    .join("\n");
}
