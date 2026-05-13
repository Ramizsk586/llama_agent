#!/usr/bin/env node
// One command to run Boop locally: server + Convex + debug dashboard + optional ngrok.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function quoteCmdArg(arg) {
  if (!/[()\][%!^"<>&|\s]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function packageBin(name) {
  return resolve(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

function spawnLocal(cmd, args, options) {
  if (process.platform === "win32" && cmd.endsWith(".cmd")) {
    return spawn("cmd.exe", ["/d", "/s", "/c", [cmd, ...args].map(quoteCmdArg).join(" ")], options);
  }
  return spawn(cmd, args, options);
}

if (!existsSync(resolve(root, "convex/_generated/api.js"))) {
  console.error(`
Convex types have not been generated yet.

Run one of these first:
  npm run setup
  npx convex dev --once
`);
  process.exit(1);
}

function readEnv() {
  const p = resolve(root, ".env.local");
  if (!existsSync(p)) return {};
  const env = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)(?:\s+#.*)?$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const envVars = readEnv();
const port = envVars.PORT || "3456";
const ngrokDomain = envVars.NGROK_DOMAIN || "";
const publicUrl = envVars.PUBLIC_URL || "";
const hasStaticUrl = publicUrl && !publicUrl.includes("localhost") && !publicUrl.includes("127.0.0.1");
const useNgrok = !hasStaticUrl || Boolean(ngrokDomain);

function hasBinary(name) {
  return new Promise((ok) => {
    const lookup = process.platform === "win32" ? "where" : "which";
    const child = spawn(lookup, [name], { stdio: "ignore" });
    child.on("exit", (code) => ok(code === 0));
    child.on("error", () => ok(false));
  });
}

function commandOutput(cmd, args) {
  return new Promise((ok) => {
    const child = spawnLocal(cmd, args, { cwd: root, env: { ...process.env } });
    let out = "";
    child.stdout?.on("data", (d) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d) => {
      out += d.toString();
    });
    child.on("exit", (code) => ok(code === 0 ? out : null));
    child.on("error", () => ok(null));
  });
}

function commandOutputWithCodes(cmd, args, okCodes = [0]) {
  return new Promise((ok) => {
    const child = spawnLocal(cmd, args, { cwd: root, env: { ...process.env } });
    let out = "";
    child.stdout?.on("data", (d) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d) => {
      out += d.toString();
    });
    child.on("exit", (code) => ok(okCodes.includes(code ?? 1) ? out : null));
    child.on("error", () => ok(null));
  });
}

function runInherit(cmd, args) {
  return new Promise((ok, fail) => {
    if (process.platform === "win32" && cmd.endsWith(".cmd")) {
      args = ["/d", "/s", "/c", [cmd, ...args].map(quoteCmdArg).join(" ")];
      cmd = "cmd.exe";
    }
    const child = spawn(cmd, args, { cwd: root, env: { ...process.env }, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}`))));
    child.on("error", fail);
  });
}

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function summarizeOutdated(outdated) {
  return Object.entries(outdated)
    .filter(([, info]) => info?.current && info?.latest && info.current !== info.latest)
    .map(([name, info]) => ({
      name,
      current: info.current,
      latest: info.latest,
      type: info.type || "dependencies",
    }));
}

async function readOutdatedPackages() {
  const out = await commandOutputWithCodes(npmCmd(), ["outdated", "--json", "--long"], [0, 1]);
  if (out === null) return null;
  if (!out.trim()) return [];
  const jsonStart = out.indexOf("{");
  if (jsonStart === -1) return [];
  try {
    return summarizeOutdated(JSON.parse(out.slice(jsonStart)));
  } catch {
    return null;
  }
}

async function confirm(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function maybeUpdateDependencies() {
  const outdated = await readOutdatedPackages();
  if (!outdated) {
    console.log(`${C.dim}Could not check npm package updates right now; starting with installed versions.${C.reset}`);
    return;
  }
  if (!outdated.length) return;

  const preview = outdated
    .slice(0, 12)
    .map((pkg) => `${pkg.name} ${pkg.current} -> ${pkg.latest}`)
    .join("\n  ");
  const more = outdated.length > 12 ? `\n  ...and ${outdated.length - 12} more` : "";
  console.log(`\n${C.upstream}Package updates are available:${C.reset}\n  ${preview}${more}\n`);

  const shouldUpdate = await confirm("Install these updates before starting Boop?");
  if (!shouldUpdate) return;

  const prod = outdated.filter((pkg) => pkg.type !== "devDependencies").map((pkg) => `${pkg.name}@latest`);
  const dev = outdated.filter((pkg) => pkg.type === "devDependencies").map((pkg) => `${pkg.name}@latest`);
  try {
    if (prod.length) await runInherit(npmCmd(), ["install", ...prod]);
    if (dev.length) await runInherit(npmCmd(), ["install", "--save-dev", ...dev]);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error("Dependency update failed; leaving the server stopped so you can retry safely.");
    process.exit(1);
  }
}

function versionAtLeast(version, minimum) {
  const current = version.split(".").map((part) => Number(part) || 0);
  const required = minimum.split(".").map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(current.length, required.length); i++) {
    const a = current[i] ?? 0;
    const b = required[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

const C = {
  server: "\x1b[36m",
  convex: "\x1b[35m",
  debug: "\x1b[33m",
  ngrok: "\x1b[32m",
  upstream: "\x1b[34m",
  banner: "\x1b[1;32m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

const NOISE_TRIGGERS = [
  /\[vite\] ws proxy socket error/,
  /\[vite\] ws proxy error/,
  /Error: write EPIPE/,
  /Error: read ECONNRESET/,
  /AggregateError \[ECONNREFUSED\]/,
];
const STACK_LINE = /^\s+at\s/;

function run(name, cmd, args, readyPattern) {
  const env = { ...process.env, FORCE_COLOR: "1" };
  if (name === "convex") {
    delete env.CONVEX_URL;
    delete env.VITE_CONVEX_URL;
    delete env.VITE_CONVEX_SITE_URL;
  }
  const child = spawnLocal(cmd, args, {
    cwd: root,
    env,
  });
  const prefix = `${C[name]}${name.padEnd(6)}${C.reset} | `;
  let buf = "";
  let suppressing = false;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const feed = (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      if (NOISE_TRIGGERS.some((r) => r.test(plain))) {
        suppressing = true;
        continue;
      }
      if (suppressing) {
        if (STACK_LINE.test(plain) || plain.trim() === "") continue;
        suppressing = false;
      }
      if (line.trim()) process.stdout.write(prefix + line + "\n");
      if (readyPattern && readyPattern.test(plain)) resolveReady();
    }
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  child.on("error", (err) => {
    process.stderr.write(prefix + `failed to start ${cmd}: ${err.message}\n`);
    resolveReady();
  });
  child.ready = ready;
  return child;
}

async function waitForNgrokUrl(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch("http://127.0.0.1:4040/api/tunnels");
      if (res.ok) {
        const data = await res.json();
        const https = data.tunnels?.find((t) => t.proto === "https")?.public_url;
        if (https) return https;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function showBanner(url, stable) {
  const line = "=".repeat(68);
  const dashboard = `${url.replace(/\/$/, "")}/dashboard`;
  const telegram = envVars.TELEGRAM_BOT_TOKEN ? "polling enabled" : "set TELEGRAM_BOT_TOKEN to enable";
  const headline = stable ? "your stable public URL is live." : "ngrok tunnel is live.";

  console.log(`
${C.banner}${line}
  Boop is ready - ${headline}

  Debug dashboard:   ${dashboard}
  Public URL:        ${url}
  Telegram:          ${telegram}
${line}${C.reset}`);
}

let ngrokInstalled = false;
let ngrokTooOld = false;
if (useNgrok) {
  ngrokInstalled = await hasBinary("ngrok");
  if (ngrokInstalled) {
    const versionOutput = await commandOutput("ngrok", ["version"]);
    const version = versionOutput?.match(/ngrok version\s+(\d+\.\d+\.\d+)/i)?.[1];
    if (version && !versionAtLeast(version, "3.20.0")) {
      ngrokTooOld = true;
      console.log(`
${C.ngrok}! ngrok ${version} is too old for this account.${C.reset}
${C.dim}  Run: ngrok update
  Or download the latest version: https://ngrok.com/download
  Continuing without a public tunnel.${C.reset}
`);
      ngrokInstalled = false;
    }
  }
  if (!ngrokInstalled && !ngrokTooOld) {
    console.log(`
${C.ngrok}! ngrok is not installed - running without a public tunnel.${C.reset}
${C.dim}  Telegram polling still works without a tunnel.
  Debug dashboard: http://localhost:5173${C.reset}
`);
  }
}

await maybeUpdateDependencies();

console.log(`\nBoop dev starting on port ${port}. Ctrl-C to stop everything.\n`);

run("upstream", "node", ["scripts/check-upstream.mjs"]);

const serverChild = run("server", "node", ["--import", "tsx", "server/index.ts"], /listening on :/);
const convexChild = run("convex", packageBin("convex"), ["dev"], /Convex functions ready/);
const debugChild = run("debug", packageBin("vite"), ["--config", "debug/vite.config.ts"], /Local:\s+http/);
const children = [serverChild, convexChild, debugChild];
const criticalChildren = [serverChild, convexChild, debugChild];

let ngrokUrlReady = Promise.resolve(null);
if (useNgrok && ngrokInstalled) {
  const args = ngrokDomain
    ? ["http", port, `--domain=${ngrokDomain}`, "--log=stdout", "--log-format=term", "--log-level=info"]
    : ["http", port, "--log=stdout", "--log-format=term", "--log-level=info"];
  const ngrokChild = run("ngrok", "ngrok", args);
  children.push(ngrokChild);
  ngrokChild.on("exit", (code) => {
    if (!shuttingDown && code !== 0) {
      console.log(`${C.ngrok}ngrok${C.reset} | tunnel unavailable. Run \`npm run setup\` and paste your ngrok authtoken, or continue with local Telegram polling.`);
    }
  });
  ngrokUrlReady = waitForNgrokUrl().catch(() => null);
}

async function autoRegisterComposioWebhook(url) {
  if (envVars.COMPOSIO_AUTO_WEBHOOK === "false") return;
  if (!envVars.COMPOSIO_API_KEY) return;
  const prefix = `${C.ngrok}composio${C.reset} | `;
  const child = spawnLocal(packageBin("tsx"), ["scripts/composio-webhook.ts", url], {
    cwd: root,
    env: { ...process.env },
  });
  child.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  child.stderr.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  await new Promise((r) => child.on("exit", r));
}

Promise.all([serverChild.ready, convexChild.ready, debugChild.ready, ngrokUrlReady])
  .then(async ([, , , ngrokUrl]) => {
    if (useNgrok && ngrokInstalled) {
      if (ngrokUrl) {
        await autoRegisterComposioWebhook(ngrokUrl);
        showBanner(ngrokUrl, Boolean(ngrokDomain));
      } else {
        console.log(`${C.ngrok}ngrok${C.reset} | could not read tunnel URL from http://127.0.0.1:4040`);
      }
    } else if (hasStaticUrl) {
      showBanner(publicUrl, true);
    } else {
      const line = "=".repeat(68);
      console.log(`
${C.banner}${line}
  Boop is running locally.

  Debug dashboard: http://localhost:5173
  Telegram polling works when TELEGRAM_BOT_TOKEN is set.
${line}${C.reset}
`);
    }
  })
  .catch(() => {});

let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 500);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
for (const c of criticalChildren) {
  c.on("exit", (code, signal) => {
    if (!shuttingDown) {
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      console.error(`\nA child process exited with ${detail}. Shutting down.`);
      shutdown(code ?? 1);
    }
  });
}
