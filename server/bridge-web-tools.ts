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

export function createBridgeWebMcp() {
  return createSdkMcpServer({
    name: "llama-bridge-web",
    version: "0.1.0",
    tools: [
      tool(
        "advanced_web_search",
        "Best default web research tool. Uses Llama Bridge source_research and verifies reachable sources. Use for current facts, news, elections, prices, recommendations, and anything requiring citations.",
        {
          query: z.string().describe("Research question or search query."),
          max_results: z.number().int().min(1).max(10).default(6),
          required_verified_sources: z.number().int().min(1).max(5).default(2),
          include_images: z.boolean().default(false),
        },
        async (args) =>
          toolText(
            await callBridgeTool("source_research", {
              query: args.query,
              max_results: args.max_results,
              required_verified_sources: args.required_verified_sources,
              include_images: args.include_images,
              skip_master_review: true,
            }),
          ),
      ),
    ],
  });
}
