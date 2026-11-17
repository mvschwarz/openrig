import fs from "node:fs";

const MAX_OUTPUT = 1024 * 1024;

export async function runHttpHook(hook, input, options = {}) {
  const timer = AbortSignal.timeout(Math.ceil(options.timeoutMs ?? hook.timeout * 1000));
  const signal = options.signal ? AbortSignal.any([timer, options.signal]) : timer;
  const allowed = new Set(hook.allowedEnvVars ?? []);
  const headers = { "Content-Type": "application/json" };
  for (const [name, value] of Object.entries(hook.headers ?? {})) {
    headers[name] = value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_match, braced, bare) => {
      const key = braced ?? bare;
      return allowed.has(key) ? options.env?.[key] ?? "" : "";
    });
  }
  try {
    const response = await (options.fetch ?? fetch)(hook.url, { method: "POST", headers, body: JSON.stringify(input), signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    let bytes = 0, stdout = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > MAX_OUTPUT) throw new Error("hook output exceeded 1 MiB");
      stdout += decoder.decode(chunk, { stream: true });
    }
    stdout += decoder.decode();
    return { code: 0, stdout, stderr: "" };
  } catch (error) { return { code: null, stdout: "", stderr: "", error: error.message }; }
}

/** Isolated native SDK sessions prevent a judging hook from recursively invoking its own plugin. */
export async function runModelHook(pi, ctx, hook, input, options = {}) {
  let session, unsubscribe;
  const timeoutMs = options.timeoutMs ?? hook.timeout * 1000;
  const signal = AbortSignal.any([AbortSignal.timeout(Math.ceil(timeoutMs)), ...(options.signal ? [options.signal] : [])]);
  const abort = () => { void session?.abort(); };
  try {
    if (signal.aborted) throw signal.reason;
    const model = hook.model ? ctx.models.resolve(hook.model) : ctx.model;
    if (!model) throw new Error(`Hook model unavailable: ${hook.model ?? "current model"}`);
    const api = pi.pi;
    const created = await api.createAgentSession({
      cwd: ctx.cwd, model, modelRegistry: ctx.modelRegistry, authStorage: ctx.modelRegistry.authStorage,
      sessionManager: api.SessionManager.inMemory(ctx.cwd), settings: api.Settings.isolated(), bindProcessState: false,
      systemPrompt: fs.readFileSync(new URL("./openrig-hook-model.md", import.meta.url), "utf8"),
      disableExtensionDiscovery: true, extensions: [], skills: [], rules: [], contextFiles: [], noContextFiles: true,
      promptTemplates: [], slashCommands: [], enableMCP: false, enableLsp: false, enableIrc: false,
      skipPythonPreflight: true, toolNames: hook.type === "agent" ? ["read", "grep", "glob"] : [],
      restrictToolNames: true, spawns: "", deadline: Date.now() + timeoutMs,
    });
    session = created.session;
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) throw signal.reason;
    let turns = 0;
    unsubscribe = session.subscribe(event => {
      if (event.type === "turn_end" && ++turns >= 50) abort();
    });
    const payload = JSON.stringify(input);
    const prompt = hook.prompt.includes("$ARGUMENTS") ? hook.prompt.replaceAll("$ARGUMENTS", payload) : `${hook.prompt}\n\n${payload}`;
    await session.prompt(prompt);
    await session.waitForIdle();
    if (signal.aborted) throw signal.reason;
    const output = JSON.parse(session.getLastAssistantText() ?? "");
    if (typeof output?.ok !== "boolean" || (!output.ok && typeof output.reason !== "string")) throw new Error("Hook model must return {ok, reason}");
    return { code: 0, stdout: JSON.stringify(output.ok ? {} : { decision: "block", reason: output.reason }), stderr: "" };
  } catch (error) { return { code: null, stdout: "", stderr: "", error: error.message }; }
  finally { signal.removeEventListener("abort", abort); unsubscribe?.(); await session?.dispose(); }
}
