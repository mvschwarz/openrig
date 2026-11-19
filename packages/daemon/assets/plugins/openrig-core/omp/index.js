// openrig-core for Oh My Pi (OMP).

import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
export const REFOCUS_SCRIPT = path.resolve(HERE, "../hooks/scripts/refocus.cjs");
/** OMP gives an event handler 30 seconds; the hook's own lookups stay inside its budget well before that. */
const HOOK_TIMEOUT_MS = 25_000;
export const REFOCUS_MESSAGE_TYPE = "openrig-refocus";

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The hook input OMP's session supplies, in the field names the hook script reads from every runtime. */
export function hookInput(event, ctx, extra = {}) {
  const manager = ctx?.sessionManager;
  return {
    hook_event_name: event,
    session_id: text(manager?.getSessionId?.()) ?? undefined,
    transcript_path: text(manager?.getSessionFile?.()) ?? undefined,
    cwd: text(ctx?.cwd) ?? undefined,
    ...extra,
  };
}

/**
 * Run the refocus hook once. Resolves with the context it wants delivered, or null: nothing due, the feature off,
 * a failure, or a timeout. It never rejects, so a refocus problem can't fail a prompt.
 */
export function runRefocus(input, options = {}) {
  const env = options.env ?? process.env;
  const command = text(env.OPENRIG_NODE) ?? "node";
  const { promise, resolve } = Promise.withResolvers();
  let child;
  try {
    child = (options.spawn ?? spawn)(command, [options.script ?? REFOCUS_SCRIPT, "--runtime", "omp"], {
      env: { ...env, ...(Number(env.OPENRIG_REFOCUS_BUDGET_MS) > HOOK_TIMEOUT_MS - 1000
        ? { OPENRIG_REFOCUS_BUDGET_MS: String(HOOK_TIMEOUT_MS - 1000) } : {}), ...(options.now ? { OPENRIG_REFOCUS_NOW: "1" } : {}) },
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return Promise.resolve(null);
  }
  const decoder = new StringDecoder("utf8");
  let stdout = "";
  const timer = setTimeout(() => {
    resolve(null);
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }, options.timeoutMs ?? HOOK_TIMEOUT_MS);
  child.stdout?.on("data", (chunk) => { stdout += typeof chunk === "string" ? chunk : decoder.write(chunk); });
  child.on("error", () => { clearTimeout(timer); resolve(null); });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) { resolve(null); return; }
    try {
      resolve(text(JSON.parse((stdout + decoder.end()) || "{}")?.hookSpecificOutput?.additionalContext));
    } catch {
      resolve(null);
    }
  });
  try {
    child.stdin?.on("error", () => { /* the hook exited before reading: nothing was due */ });
    child.stdin?.end(JSON.stringify(input));
  } catch {
    // The close handler still resolves.
  }
  return promise;
}

const isSeat = (env) => text(env.OPENRIG_SESSION_NAME) !== null;
const isMainSession = (ctx) => !ctx?.agent || ctx.agent.kind === undefined || ctx.agent.kind === "main";

/** OMP's extension entry point. */
export default function openrigCore(pi, options = {}) {
  const env = options.env ?? process.env;
  const refocus = options.runRefocus ?? runRefocus;
  pi.setLabel?.("OpenRig Core");

  pi.on("session_compact", async (_event, ctx) => {
    if (!isSeat(env) || !isMainSession(ctx)) return;
    await refocus(hookInput("PostCompact", ctx), { env });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // A revived subagent replays this event with an empty prompt; only a real prompt is a delivery boundary.
    if (!isSeat(env) || !isMainSession(ctx) || event?.reason === "revive") return;
    const context = await refocus(hookInput("UserPromptSubmit", ctx, { prompt: typeof event?.prompt === "string" ? event.prompt : "" }), { env });
    if (!context) return;
    return { message: { customType: REFOCUS_MESSAGE_TYPE, content: context, display: true } };
  });

  pi.registerCommand?.("refocus", {
    description: "Refocus now: re-read what the work is for and where it stands (OpenRig)",
    handler: async (_args, ctx) => {
      if (!isSeat(env)) {
        ctx?.ui?.notify?.("Refocus runs in an OpenRig seat; this session isn't one.", "warning");
        return;
      }
      if (!isMainSession(ctx)) return;
      const context = await refocus(hookInput("UserPromptSubmit", ctx, { prompt: "" }), { env, now: true });
      if (!context) {
        ctx?.ui?.notify?.("Refocus had nothing to deliver (it may be turned off with OPENRIG_REFOCUS_ENABLED=0).", "warning");
        return;
      }
      pi.sendMessage({ customType: REFOCUS_MESSAGE_TYPE, content: context, display: true }, { triggerTurn: true });
    },
  });
}
