import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { callBridgeTool } from "./llm/bridge-client.js";

function toolText(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function bridgeToolOk(data: unknown): boolean {
  if (!data || typeof data !== "object") return true;
  const outer = data as { ok?: unknown; result?: unknown };
  if (outer.ok === false) return false;
  if (outer.result && typeof outer.result === "object" && (outer.result as { ok?: unknown }).ok === false) {
    return false;
  }
  return true;
}

function bridgeToolErrorMessage(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const outer = data as { error?: unknown; result?: unknown };
  const result = outer.result && typeof outer.result === "object" ? outer.result as { error?: unknown } : null;
  const error = result?.error ?? outer.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : JSON.stringify(error);
  }
  return "";
}

async function advancedWebSearch(args: {
  query: string;
  max_results: number;
  required_verified_sources: number;
  include_images: boolean;
}, signal?: AbortSignal) {
  const source = await callBridgeTool("source_research", {
    query: args.query,
    max_results: args.max_results,
    required_verified_sources: args.required_verified_sources,
    include_images: args.include_images,
    skip_master_review: true,
  }, 120000, signal);
  if (bridgeToolOk(source)) return source;

  const errorMessage = bridgeToolErrorMessage(source);
  const providerMissing = /Configure SerpAPI or Tavily/i.test(errorMessage);
  if (!providerMissing) return source;

  const wikipedia = await callBridgeTool("wikipedia_search", {
    query: args.query,
    limit: Math.min(args.max_results, 10),
    language: "en",
  }, 120000, signal);

  return {
    tool: "advanced_web_search",
    ok: true,
    live_web_available: false,
    warning:
      "Live web research is not configured because both SerpAPI and Tavily are disabled. Wikipedia fallback was used; do not treat it as current news or live election results.",
    failed_live_tool: source,
    fallback_tool: "wikipedia_search",
    fallback_result: wikipedia,
  };
}

export function createBridgeWebMcp() {
  return createSdkMcpServer({
    name: "llama-bridge-web",
    version: "0.1.0",
    tools: [
      tool(
        "advanced_web_search",
        "Best available research tool. Tries Llama Bridge source_research first; if live providers are disabled, falls back to Wikipedia context and clearly reports that live web search is unavailable.",
        {
          query: z.string().describe("Research question or search query."),
          max_results: z.number().int().min(1).max(10).default(6),
          required_verified_sources: z.number().int().min(1).max(5).default(2),
          include_images: z.boolean().default(false),
        },
        async (args, extra) => {
          const signal =
            extra && typeof extra === "object" && "signal" in extra
              ? (extra as { signal?: AbortSignal }).signal
              : undefined;
          return toolText(await advancedWebSearch(args, signal));
        },
      ),
    ],
  });
}
