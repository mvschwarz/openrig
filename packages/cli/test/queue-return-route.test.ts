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

  // Slice 15: the handover line, as proven in place: check the address at each wake, first, and start the wait where the app
  // wakes on a background command's end, unless the openrig plugin's hooks already bring the tasks (#3964 O1).
  it("auto's route line says to check that address first at each wake, and gives the background wait", async () => {
    await create(deps("conversation-3f2a9c1b7e44@kernel"), ["--return-route", "auto"]);
    expect(stderr.filter(l => l.startsWith("Return route: "))).toEqual(["Return route: conversation-3f2a9c1b7e44@kernel. This work's questions "
      + "and its seats' prompts (not choice dialogs) come there as tasks. At each wake, before anything else, check that address first: "
      + "OPENRIG_SESSION_NAME='conversation-3f2a9c1b7e44@kernel' rig queue list --owned --state pending,in-progress, and put "
      + "OPENRIG_SESSION_NAME='conversation-3f2a9c1b7e44@kernel' in front of your other queue commands for this work. Where the openrig plugin's "
      + "hooks run, they bring these tasks by themselves. Elsewhere, where your app wakes you when a background command ends, start this wait "
      + "in the background now, and again after you handle each task: until "
      + "OPENRIG_SESSION_NAME='conversation-3f2a9c1b7e44@kernel' rig queue list --owned --state pending --json 2>/dev/null | grep -q '\"qitemId\"'; do sleep 20; done"]);
  });

  // Slice 15: the record the openrig plugin's hooks read. Only an issued address on this host's daemon is recorded with the
  // conversation's key; no key, no tag.
  it("auto records this conversation's key beside the issued address, after the tags it was given", async () => {
    const key = vi.fn(() => "claude:1a2b3c4d.5000:4242");
    await create({ ...deps("conversation-3f2a9c1b7e44@kernel"), conversationKey: key }, ["--return-route", "auto", "--tags", "mission:m"]);
    expect(JSON.parse(JSON.stringify(posted[0])).tags).toEqual(["mission:m", "conversation-key:claude:1a2b3c4d.5000:4242"]);
    expect(key).toHaveBeenCalledTimes(1);
  });

  // #3964 review F1: only OpenRig sets the key. One given with --tags (another conversation's, copied off a row) is dropped,
  // never refused; with auto, the derived one is the only key the create carries.
  it("drops a conversation key given with --tags and records only the one it derived", async () => {
    const given = "conversation-key:claude:1a2b3c4d.6000:5151";
    await create({ ...deps("conversation-3f2a9c1b7e44@kernel"), conversationKey: () => "claude:1a2b3c4d.5000:4242" },
      ["--return-route", "auto", "--tags", `mission:m,${given}`]);
    expect(JSON.parse(JSON.stringify(posted[0])).tags).toEqual(["mission:m", "conversation-key:claude:1a2b3c4d.5000:4242"]);
    // No key derived, or no auto: the given one is still dropped, and the create goes on with its other tags.
    await create({ ...deps("conversation-3f2a9c1b7e44@kernel"), conversationKey: () => null }, ["--return-route", "auto", "--tags", `mission:m,${given}`]);
    process.env.OPENRIG_SESSION_NAME = "front@kernel";
    await create(deps(null), ["--tags", given]);
    expect(posted).toHaveLength(3);
    expect(JSON.parse(JSON.stringify(posted[1])).tags).toEqual(["mission:m"]);
    expect(JSON.parse(JSON.stringify(posted[2]))).not.toHaveProperty("tags");
  });

  it("handoff and handoff-and-complete drop a conversation key given with --tags, since the next item keeps the work's issued address", async () => {
    process.env.OPENRIG_SESSION_NAME = "lead@starter";
    for (const verb of ["handoff", "handoff-and-complete"]) {
      posted = [];
      await queueCommand(deps(null)).parseAsync([verb, "qitem-goal", "--to", "dev-build@starter", "--summary", "the fix",
        "--tags", "mission:m,conversation-key:claude:1a2b3c4d.6000:5151", "--no-nudge"], { from: "user" });
      expect(JSON.parse(JSON.stringify(posted[0])).tags, verb).toEqual(["mission:m"]);
      posted = [];
      // Only a key given: the next item keeps the work's own tags, as with no --tags.
      await queueCommand(deps(null)).parseAsync([verb, "qitem-goal", "--to", "dev-build@starter", "--summary", "the fix",
        "--tags", "conversation-key:claude:1a2b3c4d.6000:5151", "--no-nudge"], { from: "user" });
      expect(JSON.parse(JSON.stringify(posted[0])), verb).not.toHaveProperty("tags");
    }
  });

  it("records no key when none can be derived, without auto, or on another host's daemon", async () => {
    // The control: a derivable key on a local auto create is recorded, so the absences below aren't vacuous.
    await create({ ...deps("conversation-3f2a9c1b7e44@kernel"), conversationKey: () => "claude:1a2b3c4d.5000:4242" }, ["--return-route", "auto"]);
    expect(JSON.parse(JSON.stringify(posted[0])).tags).toEqual(["conversation-key:claude:1a2b3c4d.5000:4242"]);
    await create({ ...deps("conversation-3f2a9c1b7e44@kernel"), conversationKey: () => null }, ["--return-route", "auto"]);
    expect(JSON.parse(JSON.stringify(posted[1]))).not.toHaveProperty("tags");
    const key = vi.fn(() => "claude:1a2b3c4d.5000:4242");
    process.env.OPENRIG_SESSION_NAME = "front@kernel";
    await create({ ...deps("front@kernel"), conversationKey: key }, ["--return-route", "self"]);
    await create({ ...deps(null), conversationKey: key }, []);
    await create({ ...deps("conversation-3f2a9c1b7e44@kernel@host-a"), conversationKey: key }, ["--return-route", "auto", "--host", "host-b"]);
    expect(posted).toHaveLength(5);
    for (const sent of posted.slice(2)) expect(JSON.parse(JSON.stringify(sent))).not.toHaveProperty("tags");
    expect(key).not.toHaveBeenCalled();
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
          const row = { qitemId: "qitem-x", sourceSession: "front@kernel", destinationSession: "dev-build@starter", state: "pending", body: "goal" };
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
          return { status: 201, data: { qitemId: "qitem-x", sourceSession: "front@kernel@host-a", destinationSession: "dev-build@starter",
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
      + "(not choice dialogs) come there as tasks. At each wake, before anything else, check that address first: "
      + "OPENRIG_SESSION_NAME='front@kernel' rig queue list --owned --state pending,in-progress. Where the openrig plugin's hooks run, they "
      + "bring these tasks by themselves. Elsewhere, where your app wakes you when a background command ends, start this wait in the background "
      + "now, and again after you handle each task: until OPENRIG_SESSION_NAME='front@kernel' "
      + "rig queue list --owned --state pending --json 2>/dev/null | grep -q '\"qitemId\"'; do sleep 20; done"]);
  });

  it("a local create whose named route is a registered person's prints the daemon's reason and no route line", async () => {
    const message = "The return route sam@kernel wasn't kept: it's a registered person's address, and a person is reached through the gateway, not a return route.";
    const d: QueueDeps = {
      lifecycleDeps: { readFile: () => null, exists: () => false, fetch: async () => ({ ok: true }) } as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        post: async (_url: string, body: Record<string, unknown>) => {
          posted.push(body);
          return { status: 201, data: { qitemId: "qitem-x", sourceSession: "front@kernel", destinationSession: body.destinationSession, state: "pending",
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
