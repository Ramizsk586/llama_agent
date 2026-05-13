import "./env-setup.js";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { addClient } from "./broadcast.js";
import { handleUserMessage } from "./interaction-agent.js";
import { loadIntegrations } from "./integrations/registry.js";
import { startCleanupLoop } from "./memory/clean.js";
import { startAutomationLoop } from "./automations.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { startConsolidationLoop } from "./consolidation.js";
import { cancelAgent, cleanupFinishedAgentWork, deleteAgentWork, retryAgent } from "./execution-agent.js";
import { createComposioRouter } from "./composio-routes.js";
import { ensureProactiveWatcher } from "./proactive-email.js";
import { preloadLocalModel } from "./embeddings.js";
import { createMemoryRouter } from "./memory-routes.js";
import { ensureBridgeReachable } from "./llm/bridge-client.js";
import { startTelegram } from "./channels/telegram.js";

async function main() {
  const app = express();
  app.use(cors());
  const port = Number(process.env.PORT ?? 3456);
  const debugPort = Number(process.env.DEBUG_PORT ?? 5173);

  mountDebugDashboard(app, debugPort);
  // Composio webhook receiver must read raw bytes for HMAC verification, so
  // its body parser is mounted BEFORE the global express.json. Without this
  // ordering the JSON parser consumes the stream first and the raw buffer
  // arrives empty.
  app.use("/composio/webhook", express.raw({ type: "application/json", limit: "2mb" }));
  app.use(express.json({ limit: "2mb" }));

  app.get("/", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Boop Agent</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #080d1d; color: #eef4ff; }
    main { width: min(720px, calc(100vw - 32px)); }
    h1 { margin: 0 0 10px; font-size: 40px; letter-spacing: 0; }
    p { color: #9fb0ce; line-height: 1.6; font-size: 16px; }
    .panel { border: 1px solid #25324d; background: #10182b; border-radius: 8px; padding: 28px; box-shadow: 0 24px 80px #0008; }
    .status { display: inline-flex; gap: 8px; align-items: center; color: #24d39a; font-weight: 700; }
    .dot { width: 10px; height: 10px; border-radius: 999px; background: #24d39a; box-shadow: 0 0 18px #24d39a; }
    .links { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 22px; }
    a { color: #eef4ff; text-decoration: none; border: 1px solid #30405f; border-radius: 6px; padding: 10px 14px; background: #17223a; }
    a:hover { border-color: #72a7ff; }
    code { color: #b9c8e8; }
  </style>
</head>
<body>
  <main class="panel">
    <div class="status"><span class="dot"></span> Boop is live</div>
    <h1>Boop Agent</h1>
    <p>This public URL is forwarding to Boop. Telegram polling, webhooks, and the debug dashboard use this same origin.</p>
    <p>Open the dashboard here instead of switching to localhost.</p>
    <div class="links">
      <a href="/health">Health</a>
      <a href="/dashboard">Open Dashboard</a>
      <a href="/composio/toolkits">Composio Toolkits</a>
    </div>
  </main>
</body>
</html>`);
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "boop-agent" });
  });

  app.use("/composio", createComposioRouter());
  app.use("/api/composio", createComposioRouter());
  app.use("/memory", createMemoryRouter());
  app.use("/api/memory", createMemoryRouter());

  const agentIdParam = (req: express.Request) =>
    Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const handleCancelAgent = (req: express.Request, res: express.Response) => {
    const ok = cancelAgent(agentIdParam(req));
    res.json({ ok });
  };

  const handleCleanupAgents = async (_req: express.Request, res: express.Response) => {
    try {
      res.json({ ok: true, ...(await cleanupFinishedAgentWork()) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  };

  const handleDeleteAgent = async (req: express.Request, res: express.Response) => {
    try {
      res.json({ ok: true, ...(await deleteAgentWork(agentIdParam(req))) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  };

  app.post("/agents/:id/cancel", handleCancelAgent);
  app.post("/api/agents/:id/cancel", handleCancelAgent);
  app.post("/agents/cleanup", handleCleanupAgents);
  app.post("/api/agents/cleanup", handleCleanupAgents);
  app.delete("/agents/:id", handleDeleteAgent);
  app.delete("/api/agents/:id", handleDeleteAgent);

  app.post("/consolidate", async (_req, res) => {
    try {
      const { runConsolidation } = await import("./consolidation.js");
      // Fire-and-forget so the HTTP request returns immediately.
      runConsolidation("manual").catch((err) =>
        console.error("[consolidation] manual run failed", err),
      );
      res.json({ ok: true, triggered: "manual" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
  app.post("/api/consolidate", async (_req, res) => {
    try {
      const { runConsolidation } = await import("./consolidation.js");
      runConsolidation("manual").catch((err) =>
        console.error("[consolidation] manual run failed", err),
      );
      res.json({ ok: true, triggered: "manual" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/agents/:id/retry", async (req, res) => {
    const result = await retryAgent(req.params.id);
    if (!result) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    res.json(result);
  });

  // Chat endpoint for local testing and the debug dashboard
  app.post("/chat", async (req, res) => {
    const { conversationId, content } = req.body ?? {};
    if (!conversationId || !content) {
      res.status(400).json({ error: "conversationId and content required" });
      return;
    }
    try {
      const reply = await handleUserMessage({ conversationId, content });
      res.json({ reply });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    addClient(ws);
    ws.send(JSON.stringify({ event: "hello", data: { ok: true }, at: Date.now() }));
  });

  server.listen(port, () => {
    console.log(`boop-agent server listening on :${port}`);
    console.log(`  health      GET  http://localhost:${port}/health`);
    console.log(`  chat        POST http://localhost:${port}/chat`);
    console.log(`  websocket   WS   ws://localhost:${port}/ws`);
  });

  void startBackgroundServices();
}

async function startBackgroundServices() {
  try {
    await ensureBridgeReachable();
  } catch (err) {
    console.warn("[bridge] startup check failed", err);
  }

  try {
    await loadIntegrations();
  } catch (err) {
    console.warn("[integrations] startup failed", err);
  }

  startCleanupLoop();
  startAutomationLoop();
  startHeartbeatLoop();
  startConsolidationLoop();

  // No-op when a paid embedding key is set; otherwise downloads/loads the
  // local BGE-large model in the background so the first user-facing
  // recall() doesn't pay the model-load cost.
  preloadLocalModel();

  const stableUrl = process.env.PUBLIC_URL;
  if (stableUrl && !stableUrl.includes("localhost")) {
    ensureProactiveWatcher(stableUrl).catch((err) =>
      console.error("[proactive] startup failed", err),
    );
  }

  try {
    await startTelegram();
  } catch (err) {
    console.warn("[telegram] startup failed", err);
  }
}

function mountDebugDashboard(app: express.Express, debugPort: number) {
  const debugOrigin = `http://127.0.0.1:${debugPort}`;
  const projectRoot = process.cwd();
  const debugDistDir = path.join(projectRoot, "debug", "dist");
  const debugPublicDir = path.join(projectRoot, "debug", "public");
  const vitePrefixes = [
    "/@fs",
    "/@id",
    "/@react-refresh",
    "/@vite",
    "/assets",
    "/convex",
    "/node_modules",
    "/src",
  ];
  const viteFiles = new Set([
    "/appicon.png",
    "/appicon-192.png",
    "/appicon-512.png",
    "/appicon-maskable-512.png",
    "/claude-logo.png",
    "/lunagotchi.png",
    "/manifest.webmanifest",
    "/sw.js",
    "/vite.svg",
  ]);

  app.get("/dashboard", async (_req, res) => {
    try {
      const upstream = await fetch(`${debugOrigin}/`);
      const html = await upstream.text();
      res.type("html").status(upstream.status).send(html);
    } catch {
      const html = await readDashboardFile(path.join(debugDistDir, "index.html"));
      if (html) {
        res.type("html").send(html);
        return;
      }
      res.status(503).type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Dashboard unavailable</title></head>
<body><h1>Dashboard build missing</h1><p>Run <code>npm run build:debug</code>, then restart Boop.</p></body></html>`);
    }
  });

  app.get("/dashboard/", (_req, res) => {
    res.redirect(307, "/dashboard");
  });

  app.use(async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    const requestPath = req.path;
    const isViteAsset =
      vitePrefixes.some((prefix) => requestPath === prefix || requestPath.startsWith(`${prefix}/`)) ||
      viteFiles.has(requestPath);
    if (!isViteAsset) {
      next();
      return;
    }

    try {
      const upstream = await fetch(`${debugOrigin}${req.originalUrl}`, {
        method: req.method,
        headers: {
          accept: req.get("accept") ?? "*/*",
          "user-agent": req.get("user-agent") ?? "boop-agent-dashboard-proxy",
        },
      });
      res.status(upstream.status);
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.setHeader("content-type", contentType);
      const cacheControl = upstream.headers.get("cache-control");
      if (cacheControl) res.setHeader("cache-control", cacheControl);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      const file = await readDashboardFile(path.join(debugDistDir, safePublicPath(requestPath)));
      if (file) {
        res.type(contentTypeForPath(requestPath)).send(file);
        return;
      }
      const publicFile = await readDashboardFile(path.join(debugPublicDir, safePublicPath(requestPath)));
      if (publicFile) {
        res.type(contentTypeForPath(requestPath)).send(publicFile);
        return;
      }
      res.status(503).send("debug dashboard asset is not reachable");
    }
  });
}

function safePublicPath(requestPath: string): string {
  return requestPath
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join(path.sep);
}

async function readDashboardFile(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}

function contentTypeForPath(filePath: string): string {
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".js")) return "text/javascript";
  if (filePath.endsWith(".json") || filePath.endsWith(".webmanifest")) return "application/manifest+json";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
