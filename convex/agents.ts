import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";

const statusV = v.union(
  v.literal("spawned"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const create = mutation({
  args: {
    agentId: v.string(),
    conversationId: v.optional(v.string()),
    name: v.string(),
    task: v.string(),
    mcpServers: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("executionAgents", {
      ...args,
      status: "spawned",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      startedAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    agentId: v.string(),
    status: v.optional(statusV),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    cacheReadTokens: v.optional(v.number()),
    cacheCreationTokens: v.optional(v.number()),
    costUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { agentId, ...patch } = args;
    const agent = await ctx.db
      .query("executionAgents")
      .withIndex("by_agent_id", (q) => q.eq("agentId", agentId))
      .unique();
    if (!agent) return null;
    if (agent.status === "cancelled" && patch.status && patch.status !== "cancelled") {
      patch.status = "cancelled";
    }
    const completed = patch.status && ["completed", "failed", "cancelled"].includes(patch.status);
    await ctx.db.patch(agent._id, { ...patch, ...(completed ? { completedAt: Date.now() } : {}) });
    return agent._id;
  },
});

export const addLog = mutation({
  args: {
    agentId: v.string(),
    logType: v.union(
      v.literal("thinking"),
      v.literal("tool_use"),
      v.literal("tool_result"),
      v.literal("text"),
      v.literal("error"),
    ),
    toolName: v.optional(v.string()),
    accounts: v.optional(v.array(v.string())),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("agentLogs", { ...args, createdAt: Date.now() });
  },
});

export const list = query({
  args: { status: v.optional(statusV), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    if (args.status) {
      return await ctx.db
        .query("executionAgents")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .order("desc")
        .take(limit);
    }
    return await ctx.db.query("executionAgents").order("desc").take(limit);
  },
});

export const get = query({
  args: { agentId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("executionAgents")
      .withIndex("by_agent_id", (q) => q.eq("agentId", args.agentId))
      .unique();
  },
});

export const getLogs = query({
  args: { agentId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agentLogs")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .order("asc")
      .take(args.limit ?? 500);
  },
});

async function deleteLogsForAgent(ctx: MutationCtx, agentId: string) {
  while (true) {
    const logs = await ctx.db
      .query("agentLogs")
      .withIndex("by_agent", (q) => q.eq("agentId", agentId))
      .take(100);
    if (logs.length === 0) break;
    for (const log of logs) await ctx.db.delete(log._id);
  }
}

export const remove = mutation({
  args: { agentId: v.string() },
  handler: async (ctx, args) => {
    const agent = await ctx.db
      .query("executionAgents")
      .withIndex("by_agent_id", (q) => q.eq("agentId", args.agentId))
      .unique();
    if (!agent) return { deleted: 0 };

    await deleteLogsForAgent(ctx, args.agentId);
    await ctx.db.delete(agent._id);
    return { deleted: 1 };
  },
});

export const cleanupFinished = mutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 100, 500);
    const agents = await ctx.db.query("executionAgents").order("desc").take(limit);
    let deleted = 0;

    for (const agent of agents) {
      if (agent.status === "running" || agent.status === "spawned") continue;
      await deleteLogsForAgent(ctx, agent.agentId);
      await ctx.db.delete(agent._id);
      deleted += 1;
    }

    return { deleted };
  },
});
