import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";

// `rig queue create --return-route`: a session with no address of its own can hand over a goal with `auto`, and the CLI prints
// the address OpenRig issued and how to read the team's questions there. Without the flag, create is unchanged.
describe("queue create --return-route", () => {
  const saved = { session: process.env.OPENRIG_SESSION_NAME, rigged: process.env.RIGGED_SESSION_NAME, pane: process.env.TMUX_PANE };
  let posted: Array<Record<string, unknown>>;
  let stderr: string[];
  let exit: typeof process.exitCode;
  beforeEach(() => {
    delete process.env.OPENRIG_SESSION_NAME; delete process.env.RIGGED_SESSION_NAME; delete process.env.TMUX_PANE;
    posted = []; stderr = []; exit = process.exitCode;
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { stderr.push(args.join(" ")); });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = exit;
    for (const [key, value] of [["OPENRIG_SESSION_NAME", saved.session], ["RIGGED_SESSION_NAME", saved.rigged], ["TMUX_PANE", saved.pane]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const deps = (route: string | null): QueueDeps => ({
    lifecycleDeps: { readFile: () => null, exists: () => false, fetch: async () => ({ ok: true }) } as QueueDeps["lifecycleDeps"],
    clientFactory: () => ({
      post: async (_url: string, body: Record<string, unknown>) => {
        posted.push(body);
        return { status: 201, data: { qitemId: body.qitemId, sourceSession: route ?? body.sourceSession, destinationSession: body.destinationSession,
          state: "pending", body: body.body, ...(route ? { returnRoute: route, returnRouteBasis: "issued-actor" } : {}) } };
      },
    }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
  });
  const create = (d: QueueDeps, extra: string[]) => queueCommand(d).parseAsync(["create", "--destination", "operator-agent@kernel",
    "--body", "Goal: add word counts", "--summary", "the goal", "--no-nudge", ...extra], { from: "user" });

  it("auto needs no address of its own: it sends the request without a source and prints the issued address", async () => {
    await create(deps("conversation-3f2a9c1b7e44@kernel"), ["--return-route", "auto"]);
    expect(posted).toHaveLength(1);
    const wire = JSON.parse(JSON.stringify(posted[0])); // what the client sends
    expect(wire).toMatchObject({ returnRoute: "auto" });
    expect(wire).not.toHaveProperty("sourceSession");
    const line = stderr.find(l => l.startsWith("Return route: conversation-3f2a9c1b7e44@kernel."));
    expect(line).toContain("OPENRIG_SESSION_NAME='conversation-3f2a9c1b7e44@kernel' rig queue list --owned --state pending,in-progress");
    expect(line).toContain("in front of your other queue commands for this work");
  });

  it("without the flag, or with self, a session with no address still needs one, as before", async () => {
    for (const extra of [[], ["--return-route", "self"]]) {
      process.exitCode = undefined;
      await create(deps(null), extra);
      expect(process.exitCode).toBe(1);
    }
    expect(posted).toEqual([]);
    expect(stderr.some(l => l.includes("--source is required"))).toBe(true);
  });

  it.each(["create", "handoff", "handoff-and-complete"] as const)("%s says so when the route wasn't carried to another host", async verb => {
    const message = "The return route front@kernel wasn't carried: this daemon doesn't know its own host id.";
    const d: QueueDeps = {
      lifecycleDeps: { readFile: () => null, exists: () => false, fetch: async () => ({ ok: true }) } as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        post: async (_url: string, body: Record<string, unknown>) => {
          posted.push(body);
          const row = { qitemId: String(body.qitemId), sourceSession: "front@kernel", destinationSession: "dev-build@starter", state: "pending", body: "goal" };
          const advisories = [{ code: "return_route_not_carried", message }];
          return { status: 201, data: verb === "create" ? { ...row, advisories } : { closed: { ...row, state: "handed-off" }, created: row, advisories } };
        },
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    };
    process.env.OPENRIG_SESSION_NAME = "front@kernel";
    await queueCommand(d).parseAsync(verb === "create"
      ? ["create", "--destination", "dev-build@starter", "--body", "goal", "--summary", "goal", "--return-route", "self", "--host", "host-b", "--no-nudge"]
      : [verb, "qitem-x", "--to", "dev-build@starter", "--host", "host-b", "--no-nudge"], { from: "user" });
    expect(stderr).toContain(`Warning: ${message}`);
  });

  it("a route on another host than the work's is recorded, and the receipt doesn't promise its prompts there; a local route's receipt is unchanged", async () => {
    const respond = (returnRoute: string): QueueDeps => ({
      lifecycleDeps: { readFile: () => null, exists: () => false, fetch: async () => ({ ok: true }) } as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        post: async (_url: string, body: Record<string, unknown>) => {
          posted.push(body);
          return { status: 201, data: { qitemId: String(body.qitemId), sourceSession: "front@kernel@host-a", destinationSession: "dev-build@starter",
            state: "pending", body: "goal", returnRoute, returnRouteBasis: "caller" } };
        },
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    });
    const run = (d: QueueDeps, extra: string[]) => queueCommand(d).parseAsync(["create", "--destination", "dev-build@starter", "--body", "goal",
      "--summary", "goal", "--return-route", "self", "--no-nudge", ...extra], { from: "user" });
    process.env.OPENRIG_SESSION_NAME = "front@kernel";
    // Created on host-b: the route that host stored names this host, and host-b doesn't send prompts to another host.
    await run(respond("front@kernel@host-a"), ["--host", "host-b"]);
    expect(stderr.filter(l => l.startsWith("Return route: "))).toEqual(["Return route: front@kernel@host-a is recorded with this work. It names a "
      + "conversation on another host, and the work's host sends prompts only to a route on its own host: this work's questions and its seats' "
      + "prompts follow their usual path."]);
    // Created here, with this host's route: the receipt is as before.
    stderr = [];
    await run(respond("front@kernel"), []);
    expect(stderr.filter(l => l.startsWith("Return route: "))).toEqual(["Return route: front@kernel. This work's questions and its seats' prompts "
      + "(not choice dialogs) come there as tasks; read them with OPENRIG_SESSION_NAME='front@kernel' rig queue list --owned --state pending,in-progress."]);
  });

  it("prints a host-qualified return route for a parked create", async () => {
    const d: QueueDeps = {
      lifecycleDeps: { readFile: () => null, exists: () => false, fetch: async () => ({ ok: true }) } as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        post: async (_url: string, body: Record<string, unknown>) => {
          posted.push(body);
          return { status: 201, data: {
            qitemId: String(body.qitemId), sourceSession: "front@kernel@host-a", destinationSession: body.destinationSession,
            state: "blocked", blockedOn: "external:deploy", body: body.body, parkWarning: null,
            returnRoute: "front@kernel@host-a", returnRouteBasis: "caller",
          } };
        },
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    };
    process.env.OPENRIG_SESSION_NAME = "front@kernel";
    await create(d, ["--return-route", "front@kernel@host-a", "--blocked-on", "external:deploy", "--host", "host-b"]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ returnRoute: "front@kernel@host-a", blockedOn: "external:deploy", nudge: false });
    expect(stderr.filter(line => line.startsWith("Return route: "))).toEqual(["Return route: front@kernel@host-a is recorded with this work. It names a "
      + "conversation on another host, and the work's host sends prompts only to a route on its own host: this work's questions and its seats' "
      + "prompts follow their usual path."]);
  });

  it("prints a period before the session hint for a 3-part issued-actor return route", async () => {
    await create(deps("conversation-3f2a9c1b7e44@kernel@host-a"), ["--return-route", "auto", "--host", "host-b"]);
    expect(stderr.filter(line => line.startsWith("Return route: "))).toEqual(["Return route: conversation-3f2a9c1b7e44@kernel@host-a is recorded with this work. "
      + "It names a conversation on another host, and the work's host sends prompts only to a route on its own host: this work's questions and its seats' "
      + "prompts follow their usual path. Put OPENRIG_SESSION_NAME='conversation-3f2a9c1b7e44@kernel@host-a' in front of your other queue commands for this work."]);
  });

  it("a local create whose named route is a registered person's prints the daemon's reason and no route line", async () => {
    const message = "The return route sam@kernel wasn't kept: it's a registered person's address, and a person is reached through the gateway, not a return route.";
    const d: QueueDeps = {
      lifecycleDeps: { readFile: () => null, exists: () => false, fetch: async () => ({ ok: true }) } as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        post: async (_url: string, body: Record<string, unknown>) => {
          posted.push(body);
          return { status: 201, data: { qitemId: String(body.qitemId), sourceSession: "front@kernel", destinationSession: body.destinationSession, state: "pending",
            body: body.body, tags: ["return-route-not-carried"], advisories: [{ code: "return_route_not_carried", message }] } };
        },
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    };
    process.env.OPENRIG_SESSION_NAME = "front@kernel";
    await create(d, ["--return-route", "sam@kernel"]);
    expect(JSON.parse(JSON.stringify(posted[0]))).toMatchObject({ returnRoute: "sam@kernel" });
    expect(stderr).toContain(`Warning: ${message}`);
    expect(stderr.some(l => l.startsWith("Return route:"))).toBe(false);
  });

  it("a plain create sends no route and prints no route line", async () => {
    await create(deps(null), ["--source", "front@kernel"]);
    expect(JSON.parse(JSON.stringify(posted[0]))).not.toHaveProperty("returnRoute");
    expect(stderr.some(l => l.startsWith("Return route:"))).toBe(false);
  });
});
