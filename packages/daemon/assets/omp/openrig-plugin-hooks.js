// Claude/Codex command hooks for selected OpenRig plugins, executed inside the OMP seat.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { runHttpHook, runModelHook } from "./openrig-hook-handlers.js";

const MAX_OUTPUT = 1024 * 1024;
const text = value => typeof value === "string" ? value : "";
const object = value => value && typeof value === "object" && !Array.isArray(value);
const toolNames = {
  claude: { bash: "Bash", read: "Read", write: "Write", edit: "Edit", grep: "Grep", find: "Glob", glob: "Glob", task: "Task" },
  codex: { bash: "Bash", read: "Read", write: "Write", edit: "Edit", grep: "Grep", find: "Glob", glob: "Glob", task: "Task" },
};

/** Commands receive JSON on stdin, a plugin-root environment, and the seat cwd. Kill the whole process group on
 * timeout/cancellation/output overflow so a hook's grandchildren cannot outlive a cancelled native event. */
export function runCommandHook(hook, input, options = {}) {
  const { promise, resolve } = Promise.withResolvers();
  const env = options.env ?? process.env;
  let child, timer, finished = false, stdout = "", stderr = "", bytes = 0;
  const done = result => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    resolve({ stdout, stderr, ...result });
  };
  const kill = error => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child?.kill("SIGKILL"); } catch {} }
    done({ code: null, error });
  };
  const abort = () => kill("hook cancelled");
  if (options.signal?.aborted) { done({ code: null, error: "hook cancelled" }); return promise; }
  try {
    const childEnv = { ...env, CLAUDE_PLUGIN_ROOT: hook.root, CODEX_PLUGIN_ROOT: hook.root, PLUGIN_ROOT: hook.root,
      CLAUDE_PROJECT_DIR: input.cwd, OPENRIG_SEAT_PROJECT_DIR: input.cwd };
    const expand = value => value.replace(/\$\{(\w+)\}/g, (match, key) => childEnv[key] ?? match);
    const argv = hook.args ? [expand(hook.command), ...hook.args.map(expand)] : hook.shell === "powershell"
      ? ["pwsh", "-NoProfile", "-Command", hook.command] : ["/bin/bash", "-c", hook.command];
    const collect = (kind, chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) { kill("hook output exceeded 1 MiB"); return; }
      if (kind === "stdout") stdout += chunk; else stderr += chunk;
    };
    if (globalThis.Bun) {
      // OMP is a Bun executable. Blob stdin avoids losing the final write in Bun's Node stream shim.
      child = Bun.spawn(argv, { cwd: input.cwd, env: childEnv, detached: true,
        stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
      const drain = async (stream, kind) => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) collect(kind, decoder.decode(chunk, { stream: true }));
        collect(kind, decoder.decode());
      };
      Promise.all([child.exited, drain(child.stdout, "stdout"), drain(child.stderr, "stderr")])
        .then(([code]) => done({ code }), err => kill(err.message));
    } else {
      child = spawn(argv[0], argv.slice(1), {
        cwd: input.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env: childEnv,
      });
      for (const [stream, kind] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) {
        stream.setEncoding("utf8");
        stream.on("data", chunk => collect(kind, chunk));
      }
      child.on("error", err => done({ code: null, error: err.message }));
      child.on("close", code => done({ code }));
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(input));
    }
    timer = setTimeout(() => kill("hook timed out"), options.timeoutMs ?? hook.timeout * 1000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  } catch (err) { done({ code: null, error: err.message }); }
  return promise;
}

function inputFor(event, ctx, extra, format, env) {
  const input = {
    hook_event_name: event, session_id: ctx.sessionManager?.getSessionId?.(),
    transcript_path: ctx.sessionManager?.getSessionFile?.(), cwd: ctx.cwd,
    permission_mode: env.OPENRIG_OMP_APPROVAL_MODE === "yolo" ? "bypassPermissions" : "default", ...extra,
  };
  if (extra.tool_name) {
    input.tool_name = toolNames[format][extra.tool_name] ?? extra.tool_name;
    input.tool_input = { ...extra.tool_input };
    if (typeof input.tool_input.path === "string") input.tool_input.file_path = input.tool_input.path;
  }
  if (extra.tool_calls) input.tool_calls = extra.tool_calls.map(call => {
    const normalized = inputFor("PostToolUse", ctx, call, format, env);
    return { tool_name: normalized.tool_name, tool_input: normalized.tool_input,
      tool_use_id: normalized.tool_use_id, tool_response: normalized.tool_response };
  });
  return input;
}

function matcherValue(event, input) {
  if (["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"].includes(event)) return input.tool_name;
  if (event === "SessionStart") return input.source;
  if (event === "SessionEnd") return input.reason;
  if (event === "PreCompact") return input.trigger;
  if (event === "Notification") return input.notification_type;
  if (event === "SubagentStart" || event === "SubagentStop") return input.agent_type;
  return null; // Prompt/stop/compaction completion hooks do not use tool-name matchers.
}

function lastText(message) {
  if (typeof message?.content === "string") return message.content;
  return message?.content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
}

/** Exported for tests driving real child commands through the same event callbacks OMP receives. */
export default function openrigPluginHooks(pi, options = {}) {
  const env = options.env ?? process.env;
  let plans = options.plans;
  if (!plans) {
    const file = env.OPENRIG_OMP_PLUGIN_HOOKS;
    if (!file || !fs.existsSync(file)) return;
    plans = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  if (!Array.isArray(plans)) throw new Error("Invalid selected OMP plugin hooks");
  if (!plans.length) return;
  const compatibilityWarnings = plans.flatMap(plan => plan.warnings ?? []);
  // Stock OMP has no resolvable approval event or child-stop gate. Keep useful hooks and skills.
  if (!pi.setHandlerTimeout) {
    plans = plans.map(plan => ({ ...plan, hooks: plan.hooks.filter(hook => {
      if (["SubagentStop", "PermissionRequest"].includes(hook.event)) {
        compatibilityWarnings.push(`Plugin ${plan.id}: skipped ${hook.event}; unavailable on stock OMP. Native approval remains in control.`);
        return false;
      }
      return true;
    }) }));
    compatibilityWarnings.push("Stock OMP hook limits: PreToolUse allow cannot bypass native approval; blocking hooks have a 25-second budget (1.5 seconds at shutdown).");
  }
  const run = options.run ?? ((hook, input, execution) => hook.type === "http" ? runHttpHook(hook, input, execution)
    : hook.type === "prompt" || hook.type === "agent" ? runModelHook(pi, execution.ctx, hook, input, execution)
    : runCommandHook(hook, input, execution));
  const nativeEvents = ["session_start", "session_switch", "session_branch", "input", "tool_call", "tool_result",
    "tool_approval_requested", "turn_end", "session_stop", "subagent_stop", "agent_end", "session_before_compact", "session_compact"];
  const longest = Math.min(600_000, Math.max(...plans.flatMap(p => p.hooks.filter(h => !h.async && !h.asyncRewake).map(h => h.timeout * 1000)), 30_000));
  for (const event of nativeEvents) pi.setHandlerTimeout?.(event, longest);
  const shutdownBudget = Math.min(60_000, Math.max(1500, ...plans.flatMap(p => p.hooks.filter(h => h.event === "SessionEnd").map(h => h.timeout * 1000))));
  pi.setHandlerTimeout?.("session_shutdown", shutdownBudget);
  let backgroundLifetime = new AbortController();
  const background = new Set();
  const pending = [];
  const calls = new Map();
  const preApproved = new Set();
  const completedCalls = new Map();
  let compactTrigger = "manual";
  const report = (ctx, message) => {
    ctx.ui?.notify?.(message, "error");
    pi.appendEntry?.("openrig-plugin-hook-error", { message });
  };
  const dispatch = async (event, ctx, extra = {}, signal, budget = pi.setHandlerTimeout ? longest - 100 : 25_000) => {
    signal ??= ctx.signal;
    const matches = [];
    for (const plan of plans) {
      const input = inputFor(event, ctx, extra, plan.format, env);
      for (const hook of plan.hooks) {
        if (hook.event !== event) continue;
        const value = matcherValue(event, input);
        if (hook.matcher && hook.matcher !== "*" && value !== null && !new RegExp(hook.matcher).test(value ?? "")) continue;
        matches.push({ plan, hook, input });
      }
    }
    // Native hooks run in parallel. Stable result order makes conflicting decisions deterministic.
    const outputs = await Promise.all(matches.map(async ({ plan, hook, input }) => {
      const execute = executionSignal => run({ ...hook, root: plan.root }, input,
        { env, ctx, signal: executionSignal, timeoutMs: Math.min(hook.timeout * 1000, budget) });
      if ((hook.async || hook.asyncRewake) && event !== "SessionEnd") {
        if (background.size >= 8) { report(ctx, `Plugin ${plan.id}: background hook limit reached`); return {}; }
        const lifetime = backgroundLifetime;
        const job = run({ ...hook, root: plan.root }, input, { env, ctx, signal: lifetime.signal, timeoutMs: hook.timeout * 1000 })
          .then(result => {
            if (lifetime.signal.aborted) return;
            if (result.error) { report(ctx, `Plugin ${plan.id} ${event}: ${result.error}`); return; }
            let output;
            try { output = JSON.parse(result.stdout); } catch { output = {}; }
            const context = output.hookSpecificOutput?.additionalContext || output.additionalContext;
            if (context) pending.push(text(context));
            if (output.systemMessage) ctx.ui?.notify?.(text(output.systemMessage), "info");
            if (hook.asyncRewake && result.code === 2) pi.sendMessage({ customType: "openrig-plugin-hooks",
              content: result.stderr || result.stdout || `${plan.id} requested attention`, display: false }, { deliverAs: "nextTurn", triggerTurn: true });
          }).catch(error => report(ctx, `Plugin ${plan.id} ${event}: ${error.message}`))
          .finally(() => background.delete(job));
        background.add(job);
        return {};
      }
      const result = await execute(signal);
      if (result.error || (result.code !== 0 && result.code !== 2)) {
        report(ctx, `Plugin ${plan.id} ${event}: ${result.error ?? `exit ${result.code}: ${result.stderr}`}`);
        return hook.onFailure === "block" ? { block: true, reason: result.error || result.stderr || "Hook failed" } : {};
      }
      if (result.code === 2) return { block: true, reason: text(result.stderr).trim() || `${plan.id} blocked ${event}` };
      if (!result.stdout.trim()) return {};
      let output;
      try { output = JSON.parse(result.stdout); } catch {
        if (["SessionStart", "UserPromptSubmit", "SubagentStart"].includes(event)) return { context: result.stdout.trim() };
        report(ctx, `Plugin ${plan.id} ${event}: invalid JSON output`);
        return {};
      }
      if (!object(output)) { report(ctx, `Plugin ${plan.id} ${event}: output must be an object`); return {}; }
      const specific = object(output.hookSpecificOutput) ? output.hookSpecificOutput : {};
      if (specific.hookEventName && specific.hookEventName !== event) {
        report(ctx, `Plugin ${plan.id}: returned ${specific.hookEventName} output for ${event}`);
        return {};
      }
      if (output.systemMessage) ctx.ui?.notify?.(text(output.systemMessage), "info");
      const permission = specific.permissionDecision ?? specific.decision?.behavior;
      return {
        block: output.continue === false || output.decision === "block" || permission === "deny",
        halt: output.continue === false,
        reason: text(output.stopReason || output.reason || specific.permissionDecisionReason || specific.decision?.message),
        context: text(specific.additionalContext || output.additionalContext),
        updatedInput: specific.updatedInput ?? specific.decision?.updatedInput,
        updatedPermissions: specific.decision?.updatedPermissions,
        permission,
        updatedMCPToolOutput: specific.updatedMCPToolOutput,
      };
    }));
    return {
      block: outputs.some(o => o.block), halt: outputs.some(o => o.halt),
      reason: outputs.filter(o => o.block).map(o => o.reason).filter(Boolean).join("\n"),
      context: outputs.map(o => o.context).filter(Boolean).join("\n"),
      updatedInput: outputs.findLast(o => o.updatedInput)?.updatedInput,
      updatedPermissions: outputs.find(o => o.updatedPermissions !== undefined)?.updatedPermissions,
      permission: outputs.some(o => o.permission === "deny") ? "deny" : outputs.findLast(o => o.permission)?.permission,
      updatedMCPToolOutput: outputs.findLast(o => o.updatedMCPToolOutput !== undefined)?.updatedMCPToolOutput,
    };
  };
  const queue = result => { if (result.context) pending.push(result.context); };
  const sessionStart = async (source, ctx) => {
    for (const message of compatibilityWarnings) {
      ctx.ui?.notify?.(message, "warning");
      pi.appendEntry?.("openrig-plugin-hook-warning", { message });
    }
    backgroundLifetime.abort();
    backgroundLifetime = new AbortController();
    pending.length = 0;
    calls.clear();
    preApproved.clear();
    completedCalls.clear();
    queue(await dispatch(ctx.agent?.kind === "sub" ? "SubagentStart" : "SessionStart", ctx, {
      source, agent_id: ctx.agent?.id, agent_type: ctx.agent?.name,
    }));
  };
  pi.on("session_start", (_event, ctx) => sessionStart(env.OPENRIG_OMP_SESSION_SOURCE ?? "startup", ctx));
  pi.on("session_switch", (event, ctx) => sessionStart(event.reason === "new" ? "startup" : event.reason, ctx));
  pi.on("session_branch", (_event, ctx) => sessionStart("fork", ctx));
  pi.on("input", async (event, ctx) => {
    const result = await dispatch("UserPromptSubmit", ctx, { prompt: event.text });
    if (result.block) { report(ctx, result.reason || "Prompt blocked by plugin hook"); return { handled: true }; }
    queue(result);
  });
  pi.on("before_agent_start", (event) => {
    if (event.reason === "revive" || !pending.length) return;
    return { message: { customType: "openrig-plugin-hooks", content: pending.splice(0).join("\n\n"), display: false } };
  });
  // Tool-batch and compaction context must reach the next provider request even within the same turn.
  pi.on("context", event => {
    if (!pending.length) return;
    return { messages: [...event.messages, { role: "custom", customType: "openrig-plugin-hooks",
      content: pending.splice(0).join("\n\n"), display: false, timestamp: Date.now() }] };
  });
  pi.on("tool_call", async (event, ctx) => {
    const extra = { tool_name: event.toolName, tool_input: event.input, tool_use_id: event.toolCallId };
    calls.set(event.toolCallId, extra);
    preApproved.delete(event.toolCallId);
    const result = await dispatch("PreToolUse", ctx, extra);
    if (result.halt) ctx.abort();
    if (result.block) { calls.delete(event.toolCallId); return { block: true, reason: result.reason || "Tool blocked by plugin hook" }; }
    let input = result.updatedInput;
    if (object(input)) {
      input = { ...input };
      if (input.file_path !== undefined) { input.path = input.file_path; delete input.file_path; }
      if (input.cmd !== undefined && event.toolName === "bash") { input.command = input.cmd; delete input.cmd; }
      calls.set(event.toolCallId, { ...extra, tool_input: input });
    }
    if (result.permission === "ask") {
      const approved = ctx.hasUI && await ctx.ui.confirm("Plugin tool approval", `${event.toolName}: ${JSON.stringify(input ?? event.input)}`);
      if (approved && pi.setHandlerTimeout) preApproved.add(event.toolCallId);
      if (!approved) { calls.delete(event.toolCallId); return { block: true, reason: "Plugin requested approval; tool was not approved" }; }
    }
    if (result.permission === "allow" && pi.setHandlerTimeout) preApproved.add(event.toolCallId);
    return { ...(input ? { input } : {}), ...(result.context ? { additionalContext: result.context } : {}) };
  });
  pi.on("tool_result", async (event, ctx) => {
    const extra = calls.get(event.toolCallId) ?? { tool_name: event.toolName, tool_input: event.input, tool_use_id: event.toolCallId };
    const result = await dispatch(event.isError ? "PostToolUseFailure" : "PostToolUse", ctx, {
      ...extra, tool_response: event.content, ...(event.isError ? { error: lastText(event), is_interrupt: false } : {}),
    });
    completedCalls.set(event.toolCallId, { ...extra, tool_response: event.content });
    calls.delete(event.toolCallId);
    preApproved.delete(event.toolCallId);
    if (result.halt) ctx.abort();
    const context = [result.context, result.block ? result.reason : ""].filter(Boolean).join("\n");
    return { ...(context ? { additionalContext: context } : {}),
      ...(result.updatedMCPToolOutput !== undefined ? { content: [{ type: "text", text: JSON.stringify(result.updatedMCPToolOutput) }] } : {}) };
  });
  pi.on("tool_approval_requested", async (event, ctx) => {
    const extra = calls.get(event.toolCallId) ?? { tool_name: event.toolName, tool_input: event.input, tool_use_id: event.toolCallId };
    const result = preApproved.has(event.toolCallId) && event.canResolve !== false
      ? { permission: "allow", reason: "Allowed by PreToolUse hook" }
      : await dispatch("PermissionRequest", ctx, extra);
    if (!result.block) queue(result);
    await dispatch("Notification", ctx, { notification_type: "permission_prompt", message: event.reason ?? "Tool approval requested" });
    if (result.permission === "allow" || result.block) {
      if (event.canResolve === undefined) {
        report(ctx, "The installed OMP does not expose a resolvable approval API; this PermissionRequest decision cannot be applied");
        ctx.abort();
        return;
      }
      if (result.updatedPermissions !== undefined) {
        report(ctx, "PermissionRequest.updatedPermissions is not supported by OMP; no persistent grant was written");
        return { decision: "deny", reason: "Permission hook requested an unsupported persistent grant" };
      }
      if (result.updatedInput !== undefined) {
        report(ctx, "PermissionRequest.updatedInput requires a PreToolUse hook so OMP can validate the revised tool input");
        return { decision: "deny", reason: "Permission hook requested an input change that cannot be applied at this gate" };
      }
      return { decision: result.block ? "deny" : "allow", reason: result.reason };
    }
  });
  pi.on("turn_end", async (event, ctx) => {
    if (event.toolResults?.length) {
      const tool_calls = event.toolResults.map(result => completedCalls.get(result.toolCallId) ?? {
        tool_name: result.toolName, tool_use_id: result.toolCallId, tool_input: {}, tool_response: result.content,
      });
      queue(await dispatch("PostToolBatch", ctx, { tool_calls }));
      for (const result of event.toolResults) completedCalls.delete(result.toolCallId);
    }
  });
  const stop = name => async (event, ctx) => {
    const result = await dispatch(name, ctx, {
      stop_hook_active: event.stop_hook_active, last_assistant_message: lastText(event.last_assistant_message),
      agent_id: ctx.agent?.id, agent_type: ctx.agent?.name,
    }, event.signal);
    if (result.halt) { ctx.abort(); return; }
    if (result.block) return { decision: "block", reason: result.reason || result.context || "Plugin requested continuation" };
  };
  pi.on("session_stop", stop("Stop"));
  if (pi.setHandlerTimeout) pi.on("subagent_stop", stop("SubagentStop"));
  pi.on("agent_end", async (event, ctx) => {
    const last = event.messages?.findLast(m => m.role === "assistant");
    if (!event.willContinue && last?.stopReason === "error") {
      queue(await dispatch("StopFailure", ctx, { error: last.errorMessage, last_assistant_message: lastText(last) }));
    }
  });
  pi.on("auto_compaction_start", () => { compactTrigger = "auto"; });
  pi.on("auto_compaction_end", () => { compactTrigger = "manual"; });
  pi.on("session_before_compact", async (event, ctx) => {
    const result = await dispatch("PreCompact", ctx, { trigger: compactTrigger, custom_instructions: event.customInstructions ?? "" }, event.signal);
    if (result.halt) return { cancel: true };
    queue(result);
  });
  pi.on("session_compact", async (event, ctx) => {
    queue(await dispatch("PostCompact", ctx, { trigger: compactTrigger, compact_summary: event.compactionEntry?.summary }));
    queue(await dispatch("SessionStart", ctx, { source: "compact" }));
    compactTrigger = "manual";
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    backgroundLifetime.abort();
    await Promise.allSettled([...background]);
    await dispatch("SessionEnd", ctx, { reason: "other" }, undefined, pi.setHandlerTimeout ? shutdownBudget - 100 : 1500);
  });
}
