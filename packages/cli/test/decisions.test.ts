import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { DecisionRun, decisionsStatus, loadTemplate, parseTemplate, type DecisionsSettings, type RunOptions } from "../src/decisions/decisions.js";
import { SHIPPED_TEMPLATES } from "../src/decisions/templates.js";
import { JEV_ENDPOINT, JEV_MODEL } from "../src/commands/project-jev.js";
import { ConfigStore } from "../src/config-store.js";
import { projectCommand, type ProjectDeps } from "../src/commands/project.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); process.exitCode = 0; });

const KEY = "synthetic-decisions-key";
const ON: DecisionsSettings = { enabled: true, consumers: "stream", templateDir: "" };
const OPTIONS = { owners: { "dev-lead@rig": "Owns the build pod's work" }, work: { "qitem-1": "Fix the flaky queue test" } };
const noEnv = () => new Proxy({}, { get: () => { throw Error("environment read while no call is possible"); } }) as NodeJS.ProcessEnv;
const noKeyRead = () => new Proxy({}, { get: (_t, k) => { if (k === "OPENROUTER_API_KEY") throw Error("key read while off"); return undefined; } }) as NodeJS.ProcessEnv;
const run = (o: Partial<RunOptions> = {}) => new DecisionRun({ consumer: "stream", settings: () => ON, env: { OPENROUTER_API_KEY: KEY }, ...o });
function tempDir() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "decisions-"))); }

/** A provider envelope answering each asked question with its first option, unless overridden. */
function envelope(body: string, choices: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  const questions = JSON.parse(body).questions as Record<string, { criteria: Record<string, string> }>;
  return { id: "gen-dec-1", model: JEV_MODEL + "-20260917", provider: "TypeSafe",
    answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => {
      const choice = choices[id] ?? Object.keys(q.criteria)[0]!;
      return [id, { type: "choice", choice, confidence: 0.9, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }];
    })),
    usage: { input_tokens: 400, output_tokens: 60, cost: 0.00002 }, ...extra };
}
const answering = (choices: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  vi.fn(async (_url: unknown, init?: RequestInit) => Response.json(envelope(String(init!.body), choices, extra)));

describe("no-call states make no request", () => {
  it.each<[string, Partial<RunOptions>, string]>([
    ["off", { settings: () => ({ ...ON, enabled: false }), env: noEnv() }, "disabled"],
    ["an unknown consumer", { consumer: "queue", env: noEnv() }, "unknown_consumer"],
    ["a consumer not enabled", { settings: () => ({ ...ON, consumers: "other" }), env: noEnv() }, "consumer_not_enabled"],
    ["no key in this process", { env: { OPENROUTER_API_KEY: "  " } }, "no_key"],
  ])("%s", async (_name, o, reason) => {
    const send = vi.fn(); const r = run({ ...o, send });
    expect(r.unavailable).toMatchObject({ status: "not_called", reason });
    expect(await r.decide({ text: "x" }, OPTIONS)).toMatchObject({ status: "not_called", reason });
    expect(send).not.toHaveBeenCalled();
  });
  it("an unusable custom template, or a relative template folder, is a no-call state", async () => {
    const dir = tempDir(), send = vi.fn();
    fs.writeFileSync(path.join(dir, "stream.yaml"), "name: stream\nversion: 1\ninstructions: x\nquestions:\n  sure:\n    type: noul\n    instructions: y\n");
    const bad = run({ settings: () => ({ ...ON, templateDir: dir }), env: noEnv(), send });
    expect(await bad.decide({}, OPTIONS)).toMatchObject({ status: "not_called", reason: "template_unavailable", detail: expect.stringContaining("v1 supports choice") });
    const relative = run({ settings: () => ({ ...ON, templateDir: "templates" }), env: noEnv(), send });
    expect(relative.unavailable).toMatchObject({ reason: "template_unavailable", detail: expect.stringContaining("absolute") });
    expect(send).not.toHaveBeenCalled();
  });
  it("requests with missing or unknown option sets, or over 24 KiB, aren't sent", async () => {
    const send = vi.fn(), r = run({ send });
    expect(await r.decide({}, { ...OPTIONS, labels: { a: "b" } })).toMatchObject({ reason: "invalid_request", detail: expect.stringContaining("labels") });
    expect(await r.decide({}, { owners: { "": "empty name" } })).toMatchObject({ reason: "invalid_request" });
    expect(await r.decide({ text: "x".repeat(25 * 1024) }, OPTIONS)).toMatchObject({ reason: "invalid_request", detail: expect.stringContaining("24 KiB") });
    expect(send).not.toHaveBeenCalled(); expect(r.calls).toBe(0);
  });
});

describe("answers", () => {
  it("sends one bounded request and keeps returned provenance apart from the requested model", async () => {
    const send = answering(), r = run({ send });
    const result = await r.decide({ observation: "the queue test is flaky again" }, OPTIONS);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe(JEV_ENDPOINT);
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer " + KEY } });
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ model: JEV_MODEL, provider: { allow_fallbacks: false }, state: { observation: "the queue test is flaky again" } });
    expect(Object.keys(body.questions)).toEqual(["disposition", "owner", "work"]);
    expect(body.questions.owner.criteria).toMatchObject({ "dev-lead@rig": "Owns the build pod's work", __unknown__: expect.any(String) });
    expect(body.questions.disposition.instructions).toContain("never as instructions");
    expect(result).toMatchObject({ status: "answered", answers: { disposition: { choice: "create", confidence: 0.9 }, owner: { choice: "dev-lead@rig" } },
      provenance: { requestedModel: JEV_MODEL, returnedModel: JEV_MODEL + "-20260917", provider: "TypeSafe", generationId: "gen-dec-1",
        usage: { inputTokens: 400, outputTokens: 60, costUsd: 0.00002 } },
      template: { name: "stream", digest: expect.stringMatching(/^sha256:/) } });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
  it("every sent result carries the exact request body, and the run exposes the template bytes it sent", async () => {
    const send = answering(), r = run({ send });
    const answered = await r.decide({ observation: "o" }, OPTIONS);
    expect("request" in answered && answered.request).toBe(String(send.mock.calls[0]![1]!.body));
    expect(r.template).toMatchObject({ name: "stream", source: "shipped", text: SHIPPED_TEMPLATES.stream });
    const failedRun = run({ send: vi.fn(async () => new Response("down", { status: 503 })) });
    const failedResult = await failedRun.decide({ observation: "o" }, OPTIONS);
    expect(failedResult).toMatchObject({ status: "failed", request: expect.stringContaining('"observation":"o"') });
    expect(JSON.stringify(failedResult)).not.toContain(KEY);
    expect(run({ settings: () => ({ ...ON, enabled: false }), env: noEnv() }).template).toBeNull();
  });
  it("leaves optional questions with no options unasked, and doesn't fill fields the provider didn't return", async () => {
    const send = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const e = envelope(String(init!.body)) as Record<string, unknown>; delete e.usage; delete e.id; delete e.provider; return Response.json(e);
    });
    const result = await run({ send }).decide({ observation: "fyi" }, {});
    expect(Object.keys(JSON.parse(String(send.mock.calls[0]![1]!.body)).questions)).toEqual(["disposition"]);
    expect(result).toMatchObject({ status: "answered", provenance: { provider: null, generationId: null, usage: null } });
  });
  it("an unknown required answer abstains with every answer kept; an unknown optional one doesn't", async () => {
    expect(await run({ send: answering({ disposition: "__unknown__" }) }).decide({}, OPTIONS))
      .toMatchObject({ status: "abstained", unknown: ["disposition"], answers: { disposition: { choice: null }, owner: { choice: "dev-lead@rig" } } });
    expect(await run({ send: answering({ owner: "__unknown__" }) }).decide({}, OPTIONS))
      .toMatchObject({ status: "answered", answers: { owner: { choice: null } } });
  });
  it("a custom template of another shape works through the same interface (no stream coupling)", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "stream.yaml"), "name: stream\nversion: 1\ninstructions: Size a change.\nquestions:\n  size:\n    type: choice\n" +
      "    instructions: How large is it?\n    criteria:\n      small: One file.\n      large: Many files.\n");
    const send = answering({ size: "large" });
    const result = await run({ settings: () => ({ ...ON, templateDir: dir }), send }).decide({ diff: "..." });
    expect(Object.keys(JSON.parse(String(send.mock.calls[0]![1]!.body)).questions)).toEqual(["size"]);
    expect(result).toMatchObject({ status: "answered", answers: { size: { choice: "large" } }, template: { name: "stream" } });
  });
});

describe("refusals, malformed answers and failures stay distinct", () => {
  it.each([
    ["HTTP 403", () => Response.json({ error: { code: 403, message: "Request blocked: guardrail" } }, { status: 403 })],
    ["a 403 error in a 200 body", () => Response.json({ error: { code: 403, message: "flagged" } })],
  ])("%s is refused", async (_n, reply) => {
    expect(await run({ send: vi.fn(async () => reply()) }).decide({}, OPTIONS)).toMatchObject({ status: "refused", httpStatus: 403 });
  });
  it.each<[string, Record<string, unknown> | string]>([
    ["another model", { model: "other/model" }],
    ["another release", { model: "typesafe/jev-1.14" }],
    ["another provider", { provider: "Elsewhere" }],
    ["an extra answer", { answers: "extra" }],
    ["a choice outside the options", { answers: "outside" }],
    ["probabilities that don't sum to 1", { answers: "sum" }],
    ["text that isn't JSON", "not json"],
  ])("%s is malformed, keeping returned usage", async (_n, change) => {
    const send = vi.fn(async (_u: unknown, init?: RequestInit) => {
      if (typeof change === "string") return new Response(change);
      const e = envelope(String(init!.body)) as any;
      if (change.answers === "extra") e.answers.more = e.answers.disposition;
      else if (change.answers === "outside") e.answers.disposition.choice = "escalate";
      else if (change.answers === "sum") e.answers.disposition.probabilities.create = 0.5;
      else Object.assign(e, change);
      return Response.json(e);
    });
    const result = await run({ send }).decide({}, OPTIONS);
    expect(result.status).toBe("malformed");
    if (typeof change !== "string") expect(result).toMatchObject({ provenance: { usage: { costUsd: 0.00002 } } });
  });
  it("an oversized response is malformed", async () => {
    const send = vi.fn(async () => new Response("x".repeat(257 * 1024)));
    expect(await run({ send }).decide({}, OPTIONS)).toMatchObject({ status: "malformed", detail: expect.stringContaining("256 KiB") });
  });
  it.each<[string, () => Promise<Response>, string, number | null]>([
    ["HTTP 500", async () => new Response("down", { status: 500 }), "provider", 500],
    ["HTTP 429", async () => Response.json({ error: { code: 429, message: "slow down" } }, { status: 429 }), "provider", 429],
    ["HTTP 400", async () => Response.json({ error: { code: 400, message: "bad" } }, { status: 400 }), "invocation", 400],
    ["a 502 error in a 200 body", async () => Response.json({ error: { code: 502, message: "model down" } }), "provider", 502],
    ["a network error", async () => { throw new TypeError("fetch failed"); }, "provider", null],
  ])("%s fails, is never an abstention and isn't retried", async (_n, reply, cause, httpStatus) => {
    const send = vi.fn(reply), r = run({ send });
    expect(await r.decide({}, OPTIONS)).toEqual(expect.objectContaining({ status: "failed", cause, httpStatus, upstream: "unknown" }));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("a provider error in a 200 body keeps the provenance the provider returned", async () => {
    const send = vi.fn(async () => Response.json({ id: "gen-dec-9", model: JEV_MODEL + "-20260917", provider: "TypeSafe",
      usage: { input_tokens: 10, output_tokens: 0, cost: 0.00001 }, error: { code: 502, message: "model down" } }));
    expect(await run({ send }).decide({}, OPTIONS)).toMatchObject({ status: "failed", cause: "provider", httpStatus: 502,
      provenance: { requestedModel: JEV_MODEL, returnedModel: JEV_MODEL + "-20260917", generationId: "gen-dec-9", usage: { costUsd: 0.00001 } } });
    expect(await run({ send: vi.fn(async () => { throw new TypeError("fetch failed"); }) }).decide({}, OPTIONS))
      .toMatchObject({ status: "failed", provenance: { requestedModel: JEV_MODEL, returnedModel: null, generationId: null, usage: null } });
  });
  it("an error code that throws when stringified is still read as a provider error", async () => {
    const send = vi.fn(async () => Response.json({ error: { code: { toString: 1 }, message: "odd" } }));
    expect(await run({ send }).decide({}, OPTIONS)).toMatchObject({ status: "failed", cause: "provider", detail: "provider error without a code: odd" });
  });
  it("a timeout fails within the call deadline even if the send ignores its abort signal", async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => new Promise<Response>(() => {}));
    const pending = run({ send, budget: { callTimeoutMs: 1000 } }).decide({}, OPTIONS);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: "failed", cause: "timeout", upstream: "unknown" });
  });
  it("cancel during a call fails as canceled; after stop() nothing more is sent", async () => {
    const r = run({ send: vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) });
    const pending = r.decide({}, OPTIONS);
    r.stop();
    expect(await pending).toMatchObject({ status: "failed", cause: "canceled" });
    expect(await r.decide({}, OPTIONS)).toMatchObject({ status: "not_called", reason: "canceled" });
    expect(r.calls).toBe(1);
  });
});

describe("one budget owner", () => {
  it("counts failed calls, stops at the call limit, and allows one call at a time", async () => {
    const send = vi.fn(async () => new Response("down", { status: 503 })), r = run({ send, budget: { maxCalls: 2 } });
    await r.decide({}, OPTIONS); await r.decide({}, OPTIONS);
    expect(await r.decide({}, OPTIONS)).toMatchObject({ status: "not_called", reason: "budget_spent" });
    expect(send).toHaveBeenCalledTimes(2);
    let release!: () => void;
    const slow = run({ send: vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>(resolve => { release = () => resolve(Response.json(envelope(String(init!.body)))); })) });
    const first = slow.decide({}, OPTIONS);
    expect(await slow.decide({}, OPTIONS)).toMatchObject({ status: "not_called", reason: "busy" });
    release(); expect(await first).toMatchObject({ status: "answered" });
  });
  it("after a timeout the run makes no more calls, since that transport may still be running", async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => new Promise<Response>(() => {})), r = run({ send, budget: { callTimeoutMs: 1000 } });
    const first = r.decide({}, OPTIONS);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toMatchObject({ status: "failed", cause: "timeout" });
    expect(await r.decide({}, OPTIONS)).toMatchObject({ status: "not_called", reason: "unsettled" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("turning decisions off or removing the consumer stops the next send, and the run stays stopped", async () => {
    for (const change of [(x: DecisionsSettings) => ({ ...x, enabled: false }), (x: DecisionsSettings) => ({ ...x, consumers: "other" })]) {
      let s = ON; const send = answering(), r = run({ settings: () => s, send });
      expect((await r.decide({}, OPTIONS)).status).toBe("answered");
      s = change(ON);
      expect(await r.decide({}, OPTIONS)).toMatchObject({ status: "not_called", reason: "settings_changed" });
      s = ON;
      expect(await r.decide({}, OPTIONS)).toMatchObject({ status: "not_called", reason: "settings_changed" });
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
  it("the run's total deadline spans every call", async () => {
    let t = 0; const send = answering(), r = run({ send, now: () => t, budget: { deadlineMs: 5000 } });
    t = 5000;
    expect(await r.decide({}, OPTIONS)).toMatchObject({ status: "not_called", reason: "budget_spent" });
    expect(send).not.toHaveBeenCalled();
    expect(() => run({ budget: { maxCalls: 0 } })).toThrow(/maxCalls 1..100/);
  });
});

describe("stale answers aren't returned as answers", () => {
  it("turned off during the call", async () => {
    let s = ON; const r = run({ settings: () => s, send: vi.fn(async (_u: unknown, init?: RequestInit) => { s = { ...ON, enabled: false }; return Response.json(envelope(String(init!.body))); }) });
    expect(await r.decide({}, OPTIONS)).toMatchObject({ status: "stale", reason: expect.stringContaining("turned off"), provenance: { usage: { costUsd: 0.00002 } } });
  });
  it("the template changed during the call", async () => {
    const dir = tempDir(), file = path.join(dir, "stream.yaml");
    fs.writeFileSync(file, SHIPPED_TEMPLATES.stream!);
    const r = run({ settings: () => ({ ...ON, templateDir: dir }), send: vi.fn(async (_u: unknown, init?: RequestInit) => {
      fs.writeFileSync(file, SHIPPED_TEMPLATES.stream!.replace("Decide what should happen", "Decide what happens")); return Response.json(envelope(String(init!.body)));
    }) });
    expect(await r.decide({}, OPTIONS)).toMatchObject({ status: "stale", reason: expect.stringContaining("template changed") });
  });
  it("the answer arrived after the run's deadline", async () => {
    let t = 0; const r = run({ now: () => t, budget: { deadlineMs: 5000 }, send: vi.fn(async (_u: unknown, init?: RequestInit) => { t = 5001; return Response.json(envelope(String(init!.body))); }) });
    expect(await r.decide({}, OPTIONS)).toMatchObject({ status: "stale", reason: expect.stringContaining("deadline") });
  });
});

describe("templates", () => {
  it("the shipped stream template is valid and only disposition is required", () => {
    const t = loadTemplate("stream", "");
    expect(t.source).toBe("shipped");
    expect(Object.fromEntries(Object.entries(t.questions).map(([id, q]) => [id, [q.required, q.criteriaFrom ?? null]])))
      .toEqual({ disposition: [true, null], owner: [false, "owners"], work: [false, "work"] });
  });
  it.each([
    ["an unknown field", "name: stream\nversion: 1\ninstructions: x\nrun: ls\nquestions:\n  a:\n    type: choice\n    instructions: y\n    criteria: {b: c}\n", /only name, version/],
    ["the wrong name", "name: other\nversion: 1\ninstructions: x\nquestions:\n  a:\n    type: choice\n    instructions: y\n    criteria: {b: c}\n", /must be stream/],
    ["a reserved option", "name: stream\nversion: 1\ninstructions: x\nquestions:\n  a:\n    type: choice\n    instructions: y\n    criteria: {__unknown__: c}\n", /reserved/],
    ["criteria and criteria_from", "name: stream\nversion: 1\ninstructions: x\nquestions:\n  a:\n    type: choice\n    instructions: y\n    criteria: {b: c}\n    criteria_from: owners\n", /criteria or criteria_from/],
    ["YAML aliases", "name: stream\nversion: 1\ninstructions: &i x\nquestions:\n  a:\n    type: choice\n    instructions: *i\n    criteria: {b: c}\n", /alias/i],
  ])("refuses %s", (_n, raw, message) => {
    expect(() => parseTemplate(raw, "stream", "test")).toThrow(message);
  });
});

describe("status", () => {
  it("off: no call, and the key isn't checked", () => {
    expect(decisionsStatus({ ...ON, enabled: false }, noKeyRead())).toMatchObject({ state: "no_call", key: { present: null }, route: { model: JEV_MODEL, retries: 0 } });
  });
  it("names a missing key and how a managed seat gets one", () => {
    expect(decisionsStatus(ON, {})).toMatchObject({ state: "no_call", key: { present: false }, reason: expect.stringContaining("recovery.provider_auth_env_allowlist") });
  });
  it("enabled with a key, without printing it; an unknown consumer degrades", () => {
    const enabled = decisionsStatus(ON, { OPENROUTER_API_KEY: KEY, OPENRIG_SESSION_NAME: "queue-worker@kernel" });
    expect(enabled).toMatchObject({ state: "enabled", key: { present: true }, invoking: { session: "queue-worker@kernel" },
      consumers: [{ name: "stream", state: "enabled", template: { source: "shipped" } }] });
    expect(JSON.stringify(enabled)).not.toContain(KEY);
    expect(decisionsStatus({ ...ON, consumers: "stream, queue" }, { OPENROUTER_API_KEY: KEY }))
      .toMatchObject({ state: "degraded", consumers: [{ name: "stream", state: "enabled" }, { name: "queue", state: "unknown" }] });
  });
  it("rig project decisions status prints it as JSON", async () => {
    const out: string[] = []; vi.spyOn(console, "log").mockImplementation(x => { out.push(String(x)); });
    await new Command().addCommand(projectCommand({ lifecycleDeps: {}, clientFactory: () => { throw Error("daemon forbidden"); },
      decisionsSettings: () => ON, experimentEnv: { OPENROUTER_API_KEY: KEY } } as ProjectDeps)).parseAsync(["project", "decisions", "status"], { from: "user" });
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ state: "enabled", consumers: [{ name: "stream", state: "enabled" }] });
  });
});

describe("settings", () => {
  it("defaults off, and the template folder must be absolute", () => {
    const dir = tempDir(), store = new ConfigStore(path.join(dir, "config.json"));
    expect([store.get("decisions.enabled"), store.get("decisions.consumers"), store.get("decisions.template_dir")]).toEqual([false, "", ""]);
    expect(() => store.set("decisions.template_dir", "relative/templates")).toThrow(/absolute path/);
    store.set("decisions.template_dir", dir); store.set("decisions.enabled", "true"); store.set("decisions.consumers", "stream");
    expect(store.resolve().decisions).toEqual({ enabled: true, consumers: "stream", templateDir: dir });
  });
});
