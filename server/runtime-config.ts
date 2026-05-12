import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { bridgeModel } from "./llm/bridge-client.js";

const MODEL_KEY = "model";
const MODEL_TTL_MS = 30 * 1000;
let cached: { at: number; value: string } | null = null;

// User-friendly aliases the agent can pass through from Telegram. The bridge
// owns actual provider/model routing; these aliases keep the old UX while
// mapping everything to the configured bridge model by default.
export const MODEL_ALIASES: Record<string, string> = {
  bridge: bridgeModel(),
  default: bridgeModel(),
  fast: bridgeModel(),
  balanced: bridgeModel(),
  capable: bridgeModel(),
};

export const KNOWN_MODELS = new Set<string>([bridgeModel()]);

export function resolveModelInput(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  return MODEL_ALIASES[lower] ?? value;
}

function envFallback(): string {
  return process.env.LLAMA_BRIDGE_MODEL ?? bridgeModel();
}

export async function getRuntimeModel(): Promise<string> {
  if (cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.value;
  let stored: string | null = null;
  try {
    stored = await convex.query(api.settings.get, { key: MODEL_KEY });
  } catch (err) {
    console.warn("[runtime-config] settings:get failed", err);
  }
  // Re-validate even though set_model writes through resolveModelInput â€” the
  // settings table is also writable via the Convex dashboard and other
  // mutations, and a bad value here would surface as an opaque SDK 4xx on the
  // next turn instead of falling back gracefully.
  const final = stored?.trim() || envFallback();
  cached = { at: Date.now(), value: final };
  return final;
}

export async function setRuntimeModel(model: string): Promise<void> {
  await convex.mutation(api.settings.set, { key: MODEL_KEY, value: model });
  cached = { at: Date.now(), value: model };
}

export async function clearRuntimeModel(): Promise<void> {
  await convex.mutation(api.settings.clear, { key: MODEL_KEY });
  cached = null;
}

