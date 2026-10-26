// #1679: `rig slack post-open-asks` asks the daemon to show the asks still open after enable, and prints what became of each.
import { describe, expect, it } from "vitest";
import { slackCommand, describeOpenAsks, type SlackDeps } from "../src/commands/slack.js";

function deps(response: { status: number; data: unknown } | Error) {
  const logs: string[] = [];
  const calls: Array<{ path: string; body: Record<string, unknown>; timeoutMs?: number }> = [];
  const d: SlackDeps = {
    log: (m) => logs.push(m),
    clientFactory: () => ({
      post: async <T>(path: string, body?: unknown, options?: { timeoutMs?: number }) => {
        calls.push({ path, body: body as Record<string, unknown>, timeoutMs: options?.timeoutMs });
        if (response instanceof Error) throw response;
        return response as { status: number; data: T };
      },
    }),
  };
  return { d, logs, calls };
}
const run = (d: SlackDeps, argv: string[]) => slackCommand(d).parseAsync(["node", "slack", ...argv]);

describe("rig slack post-open-asks", () => {
  it("posts its reason and wait to the daemon and prints a count line, one line per ask, and what to do next", async () => {
    const { d, logs, calls } = deps({ status: 200, data: { ok: true, asks: [
      { qitemId: "q-1", recipient: "alex@external", summary: "Pick a port", outcome: "posted" },
      { qitemId: "q-2", recipient: "alex@external", summary: "Name it", outcome: "held", detail: "quiet hours: their release posts it when quiet hours end" },
      { qitemId: "q-3", recipient: "alex@external", summary: "Ship?", outcome: "queued" },
    ] } });
    await run(d, ["post-open-asks", "--reason", "catching up", "--wait", "5", "--actor", "alex@host"]);
    expect(calls).toEqual([{ path: "/api/gateway/slack/post-open-asks", body: expect.objectContaining({ reason: "catching up", waitSeconds: 5 }), timeoutMs: 35_000 }]);
    expect(logs[0]).toBe("3 open ask(s): 1 posted, 1 held, 1 queued, awaiting receipt");
    expect(logs[1]).toBe("  posted: q-1 for alex@external: Pick a port");
    expect(logs[2]).toBe("  held: q-2 for alex@external: Name it (quiet hours: their release posts it when quiet hours end)");
    expect(logs.join("\n")).toMatch(/Run `rig slack post-open-asks` again later .* reuses each ask's decision rather than offering it again/);
  });

  it("says the daemon's reason and exits 1 when Slack isn't posting, and when the daemon can't be reached", async () => {
    for (const response of [
      { status: 409, data: { error: "slack_not_posting", message: "Slack isn't enabled on this machine, so no ask was shown. Run rig slack enable first, then this." } },
      new Error("daemon unreachable"),
    ]) {
      const { d, logs } = deps(response);
      process.exitCode = 0;
      await run(d, ["post-open-asks"]);
      expect(process.exitCode).toBe(1);
      expect(logs.join("\n")).toMatch(/post-open-asks failed: (Slack isn't enabled|daemon unreachable)/);
    }
    process.exitCode = 0;
  });

  it("refuses a wait outside 0 to 60 seconds before contacting the daemon", async () => {
    const { d, logs, calls } = deps({ status: 200, data: { ok: true, asks: [] } });
    await run(d, ["post-open-asks", "--wait", "600"]);
    expect(calls).toHaveLength(0);
    expect(logs.join("\n")).toContain("--wait takes 0 to 60 seconds");
    process.exitCode = 0;
  });

  it("enable points to it only when enable seeded open asks", async () => {
    for (const seeded of [2, 0]) {
      const { d, logs, calls } = deps({ status: 200, data: { ok: true, seeded, onlineStatus: `slack outbound ENABLED at enable-time: ${seeded} pre-existing alert(s) seeded as history (not reposted)` } });
      await run(d, ["enable"]);
      expect(calls.map((c) => c.path)).toEqual(["/api/gateway/slack/enable"]);
      expect(logs.some((line) => line.includes("run `rig slack post-open-asks`"))).toBe(seeded > 0);
    }
  });

  it("names each outcome plainly, and says when there's nothing open", () => {
    expect(describeOpenAsks([])).toEqual(["No open asks to show."]);
    const lines = describeOpenAsks([
      { qitemId: "q-4", recipient: "alex@external", summary: null, outcome: "state-unavailable", detail: "not posted: quiet hours couldn't be read" },
      { qitemId: "q-5", recipient: "alex@external", summary: "S", outcome: "below-floor", detail: "asked at RECORD: it waits on Steering and the Feed without a Slack post" },
      { qitemId: "q-6", recipient: "alex@external", summary: "T", outcome: "transport-failed", detail: "transport" },
    ]);
    expect(lines[0]).toBe("3 open ask(s): 1 state unavailable, 1 below the posting floor, 1 transport failed");
    expect(lines.join("\n")).toMatch(/No new offer was made .* its detail says what couldn't be read and what is known/);
    expect(lines.join("\n")).toMatch(/rig queue undelivered/);
  });
});
