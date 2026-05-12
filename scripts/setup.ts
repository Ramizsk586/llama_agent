#!/usr/bin/env tsx
import prompts from "prompts";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = resolve(ROOT, ".env.local");
const EXAMPLE_PATH = resolve(ROOT, ".env.example");

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

function writeEnv(path: string, env: Record<string, string>): void {
  const example = existsSync(EXAMPLE_PATH) ? readFileSync(EXAMPLE_PATH, "utf8") : "";
  let out = "";
  const seen = new Set<string>();
  const sections = example.split(/\n(?=# ----)/);

  for (const section of sections) {
    let text = section;
    const keys = [...section.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]);
    for (const key of keys) {
      const pattern = new RegExp(`^${key}=.*(\\r?\\n)?`, "gm");
      if (seen.has(key)) {
        text = text.replace(pattern, "");
        continue;
      }
      const value = env[key] ?? "";
      let replaced = false;
      text = text.replace(pattern, (match) => {
        if (replaced) return "";
        replaced = true;
        seen.add(key);
        return `${key}=${value}` + (match.endsWith("\n") ? "\n" : "");
      });
    }
    out += text + "\n";
  }

  for (const [key, value] of Object.entries(env)) {
    if (!seen.has(key)) out += `${key}=${value}\n`;
  }
  writeFileSync(path, out.trim() + "\n");
}

function cleanConvexUrlEnv(path: string): void {
  if (!existsSync(path)) return;
  const envContent = readFileSync(path, "utf8");
  writeFileSync(path, envContent.replace(/^VITE_CONVEX_URL=.*(\r?\n)?/gm, ""));
}

function stripEnvAssignment(value: string, key: string): string {
  const prefix = `${key}=`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function resolveWindowsCmd(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function banner(text: string): void {
  console.log("\n" + "=".repeat(60));
  console.log("  " + text);
  console.log("=".repeat(60));
}

function openInBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* printed URL is the fallback */
  }
}

function quoteCmdArg(arg: string): string {
  if (!/[()\][%!^"<>&|\s]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function packageBin(name: string): string {
  return resolve(ROOT, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

function hasBinary(name: string): Promise<boolean> {
  return new Promise((ok) => {
    const lookup = process.platform === "win32" ? "where" : "which";
    const child = spawn(lookup, [name], { stdio: "ignore" });
    child.on("exit", (code) => ok(code === 0));
    child.on("error", () => ok(false));
  });
}

function runInherit(cmd: string, args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    if (process.platform === "win32" && cmd.endsWith(".cmd")) {
      args = ["/d", "/s", "/c", [cmd, ...args].map(quoteCmdArg).join(" ")];
      cmd = "cmd.exe";
    }
    const child = spawn(cmd, args, { stdio: "inherit", cwd: ROOT });
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
    child.on("error", fail);
  });
}

async function tryRunInherit(cmd: string, args: string[]): Promise<boolean> {
  try {
    await runInherit(cmd, args);
    return true;
  } catch (err) {
    console.warn(err instanceof Error ? err.message : err);
    return false;
  }
}

async function runConvexDev(): Promise<void> {
  const existing = readEnv(ENV_PATH);
  const args = existing.CONVEX_DEPLOYMENT
    ? ["dev", "--once"]
    : ["dev", "--once", "--configure", "new"];

  if (!existing.CONVEX_DEPLOYMENT) cleanConvexUrlEnv(ENV_PATH);
  console.log(`\nLaunching \`convex ${args.join(" ")}\` to configure Convex.`);
  console.log("Convex may open a browser window if you are not logged in.");
  await runInherit(packageBin("convex"), args);
}

async function runDependencyUpdates(): Promise<void> {
  banner("Updates");
  const { updateDeps } = await prompts({
    type: "confirm",
    name: "updateDeps",
    message: "Update npm packages to newer compatible versions now?",
    initial: true,
  });
  if (!updateDeps) return;

  await tryRunInherit(resolveWindowsCmd("npm"), ["update"]);

  const { updateConvex } = await prompts({
    type: "confirm",
    name: "updateConvex",
    message: "Upgrade Convex to the latest published version too?",
    initial: true,
  });
  if (updateConvex) {
    await tryRunInherit(resolveWindowsCmd("npm"), ["install", "convex@latest"]);
  }
}

async function installNgrok(): Promise<boolean> {
  if (process.platform === "win32" && (await hasBinary("winget"))) {
    console.log("\nInstalling ngrok with winget.");
    for (const id of ["Ngrok.Ngrok", "ngrok.ngrok"]) {
      if (await tryRunInherit("winget", ["install", "--id", id, "-e", "--accept-source-agreements", "--accept-package-agreements"])) {
        return true;
      }
    }
  }

  if (await hasBinary("choco")) {
    console.log("\nInstalling ngrok with Chocolatey.");
    if (await tryRunInherit("choco", ["install", "ngrok", "-y"])) return true;
  }

  if (await hasBinary("scoop")) {
    console.log("\nInstalling ngrok with Scoop.");
    if (await tryRunInherit("scoop", ["install", "ngrok"])) return true;
  }

  console.log("\nCould not install ngrok automatically. Opening the official download page.");
  openInBrowser("https://ngrok.com/download");
  return false;
}

async function configureNgrok(): Promise<void> {
  banner("ngrok tunnel");
  const alreadyInstalled = await hasBinary("ngrok");
  const { setupNgrok } = await prompts({
    type: "confirm",
    name: "setupNgrok",
    message: alreadyInstalled ? "Configure ngrok authtoken now?" : "Install and configure ngrok now?",
    initial: true,
  });
  if (!setupNgrok) return;

  if (!alreadyInstalled) {
    await installNgrok();
  } else {
    const { upgradeNgrok } = await prompts({
      type: "confirm",
      name: "upgradeNgrok",
      message: "Check for an ngrok agent update now?",
      initial: true,
    });
    if (upgradeNgrok) {
      const updated = await tryRunInherit("ngrok", ["update"]);
      if (!updated && process.platform === "win32" && (await hasBinary("winget"))) {
        await tryRunInherit("winget", ["upgrade", "--id", "Ngrok.Ngrok", "-e", "--accept-source-agreements", "--accept-package-agreements"]);
      }
    }
  }

  if (!(await hasBinary("ngrok"))) {
    console.log("\nAfter installing ngrok, open a new PowerShell and rerun setup to add your authtoken.");
    return;
  }

  console.log("\nOpening ngrok authtoken page.");
  openInBrowser("https://dashboard.ngrok.com/get-started/your-authtoken");
  const { NGROK_AUTHTOKEN } = await prompts({
    type: "password",
    name: "NGROK_AUTHTOKEN",
    message: "Paste your ngrok authtoken (leave blank to skip):",
    initial: "",
  });
  const token = stripEnvAssignment(NGROK_AUTHTOKEN || "", "NGROK_AUTHTOKEN");
  if (token) {
    const configured = await tryRunInherit("ngrok", ["config", "add-authtoken", token]);
    if (!configured) {
      console.log("\nCould not save the ngrok authtoken. You can run this manually:");
      console.log("  ngrok config add-authtoken <your-token>");
      return;
    }
  } else {
    console.log("\nSkipped ngrok authtoken. The dev server will keep running locally if ngrok cannot start.");
  }

  const { NGROK_DOMAIN } = await prompts({
    type: "text",
    name: "NGROK_DOMAIN",
    message: "Reserved ngrok domain (optional, no https://):",
    initial: readEnv(ENV_PATH).NGROK_DOMAIN ?? "",
  });
  const domain = stripEnvAssignment((NGROK_DOMAIN || "").trim(), "NGROK_DOMAIN").replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (domain) {
    const env = readEnv(ENV_PATH);
    writeEnv(ENV_PATH, { ...env, NGROK_DOMAIN: domain, PUBLIC_URL: `https://${domain}` });
  }
}

async function main(): Promise<void> {
  banner("boop-agent setup");
  console.log(`
This setup configures a Telegram-only Llama Agent.

Before you start:
  - Llama Bridge should be running locally.
  - Create a Telegram bot with BotFather and paste its token here.
  - Convex account is needed for memory/state: https://convex.dev
`);

  const existing = readEnv(ENV_PATH);
  await runDependencyUpdates();

  const answers = (await prompts(
    [
      {
        type: "text",
        name: "LLAMA_BRIDGE_URL",
        message: "Llama Bridge URL",
        initial: existing.LLAMA_BRIDGE_URL ?? "http://127.0.0.1:8089",
      },
      {
        type: "text",
        name: "LLAMA_BRIDGE_MODEL",
        message: "Llama Bridge model alias",
        initial: existing.LLAMA_BRIDGE_MODEL ?? "sonnet",
      },
      {
        type: "password",
        name: "LLAMA_BRIDGE_API_KEY",
        message: "Llama Bridge auth token (must match server.auth_token in env.yml)",
        initial: existing.LLAMA_BRIDGE_API_KEY ?? "change-me",
      },
      {
        type: "password",
        name: "TELEGRAM_BOT_TOKEN",
        message: "Telegram bot token (leave blank to disable Telegram polling)",
        initial: existing.TELEGRAM_BOT_TOKEN ?? "",
      },
      {
        type: "text",
        name: "TELEGRAM_NOTIFY_CHAT_ID",
        message: "Telegram chat ID for proactive notices (optional)",
        initial: existing.TELEGRAM_NOTIFY_CHAT_ID ?? "",
      },
      {
        type: "text",
        name: "PORT",
        message: "Local server port",
        initial: existing.PORT ?? "3456",
      },
      {
        type: "confirm",
        name: "runConvex",
        message: "Run `convex dev` now to configure your Convex deployment?",
        initial: true,
      },
    ],
    {
      onCancel: () => {
        console.log("Setup cancelled.");
        process.exit(1);
      },
    },
  )) as Record<string, string | boolean>;
  if (typeof answers.LLAMA_BRIDGE_API_KEY === "string") {
    answers.LLAMA_BRIDGE_API_KEY = stripEnvAssignment(answers.LLAMA_BRIDGE_API_KEY, "LLAMA_BRIDGE_API_KEY");
  }
  if (typeof answers.TELEGRAM_BOT_TOKEN === "string") {
    answers.TELEGRAM_BOT_TOKEN = stripEnvAssignment(answers.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN");
  }

  banner("Composio integrations");
  const existingComposio = existing.COMPOSIO_API_KEY ?? "";
  const composioSettingsUrl = "https://platform.composio.dev/settings";
  const { composioMode } = await prompts(
    {
      type: "select",
      name: "composioMode",
      message: existingComposio ? "Composio API key detected. Keep it or replace?" : "Configure Composio now?",
      choices: existingComposio
        ? [
            { title: "Keep existing key", value: "keep" },
            { title: "Replace", value: "replace" },
            { title: "Skip", value: "skip" },
          ]
        : [
            { title: "Yes - open dashboard and paste my key", value: "replace" },
            { title: "Skip for now", value: "skip" },
          ],
      initial: 0,
    },
    {
      onCancel: () => {
        console.log("Setup cancelled.");
        process.exit(1);
      },
    },
  );

  if (composioMode === "replace") {
    console.log(`\nOpening ${composioSettingsUrl}`);
    openInBrowser(composioSettingsUrl);
    const { COMPOSIO_API_KEY } = await prompts({
      type: "password",
      name: "COMPOSIO_API_KEY",
      message: "Paste your Composio API key (leave blank to skip):",
      initial: "",
    });
    answers.COMPOSIO_API_KEY = stripEnvAssignment(COMPOSIO_API_KEY || "", "COMPOSIO_API_KEY") || existingComposio;
  } else {
    answers.COMPOSIO_API_KEY = existingComposio;
  }

  banner("Memory search");
  const existingVoyage = existing.VOYAGE_API_KEY ?? "";
  const existingOpenai = existing.OPENAI_API_KEY ?? "";
  const inferred = existingVoyage ? "voyage" : existingOpenai ? "openai" : "local";
  const { embeddingProvider } = await prompts({
    type: "select",
    name: "embeddingProvider",
    message: "Which embedding provider should Boop use?",
    choices: [
      { title: "Local (free, recommended)", value: "local" },
      { title: "Voyage (paid)", value: "voyage" },
      { title: "OpenAI (paid)", value: "openai" },
    ],
    initial: inferred === "voyage" ? 1 : inferred === "openai" ? 2 : 0,
  });

  if (embeddingProvider === "voyage") {
    const { VOYAGE_API_KEY } = await prompts({
      type: "password",
      name: "VOYAGE_API_KEY",
      message: "Paste your Voyage API key:",
      initial: existingVoyage,
    });
    answers.VOYAGE_API_KEY = stripEnvAssignment(VOYAGE_API_KEY || "", "VOYAGE_API_KEY");
    answers.OPENAI_API_KEY = "";
  } else if (embeddingProvider === "openai") {
    const { OPENAI_API_KEY } = await prompts({
      type: "password",
      name: "OPENAI_API_KEY",
      message: "Paste your OpenAI API key:",
      initial: existingOpenai,
    });
    answers.OPENAI_API_KEY = stripEnvAssignment(OPENAI_API_KEY || "", "OPENAI_API_KEY");
    answers.VOYAGE_API_KEY = "";
  } else {
    answers.VOYAGE_API_KEY = "";
    answers.OPENAI_API_KEY = "";
    const { preload } = await prompts({
      type: "confirm",
      name: "preload",
      message: "Pre-download the local embedding model now? (~440MB)",
      initial: true,
    });
    if (preload) {
      try {
        await runInherit(packageBin("tsx"), ["scripts/preload-embeddings.ts"]);
      } catch (err) {
        console.warn("Preload failed; the model will download on first recall.", err);
      }
    }
  }

  const env: Record<string, string> = { ...existing };
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value === "string") env[key] = value;
  }
  delete env["BOOP" + "_MODEL"];
  delete env["ANTHROPIC" + "_API_KEY"];
  if (!env.PUBLIC_URL) env.PUBLIC_URL = `http://localhost:${env.PORT ?? "3456"}`;
  delete env.CONVEX_URL;
  if (env.VITE_CONVEX_URL?.includes("example.convex.cloud")) delete env.VITE_CONVEX_URL;
  writeEnv(ENV_PATH, env);

  await configureNgrok();

  banner("Llama Bridge");
  console.log(`All LLM traffic goes to Llama Bridge at:\n  ${env.LLAMA_BRIDGE_URL}`);

  if (answers.runConvex) {
    await runConvexDev();
    const after = readEnv(ENV_PATH);
    const deploymentMatch = after.CONVEX_DEPLOYMENT?.match(/^([a-z]+):([\w-]+)/);
    if (deploymentMatch) {
      const url = after.VITE_CONVEX_URL || after.CONVEX_URL || `https://${deploymentMatch[2]}.convex.cloud`;
      if (after.VITE_CONVEX_URL !== url || after.CONVEX_URL) {
        const next: Record<string, string> = { ...after, VITE_CONVEX_URL: url };
        delete next.CONVEX_URL;
        writeEnv(ENV_PATH, next);
        console.log(`\nSynced VITE_CONVEX_URL -> ${url}`);
      }
    }
  } else {
    console.log("\nSkipped Convex. Run `npx convex dev --once` yourself when ready.");
  }

  banner("Ready");
  console.log(`
Run:
  npm run dev

Telegram:
  1. Message your bot once in Telegram.
  2. The server polls Telegram when TELEGRAM_BOT_TOKEN is set.
  3. Optional proactive notices use TELEGRAM_NOTIFY_CHAT_ID.

Debug dashboard:
  http://localhost:5173
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
