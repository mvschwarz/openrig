import { describe, expect, it, vi } from "vitest";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { binary, name, real, rotatedToken, rotation, rowsWith, seat, standIn, token, autoScreen } from "./helpers/claude-sweeper-seat.js";

// #1477 section 2. After a daemon restart no launch record exists, so a banner-less auto-mode Claude can
// never be proved by the launch path, and the sweepers (which pass a binding with no pane) left it in
// attention. With the seat's real binding and its resume token, the adapter proves it the way
// `rig seat clear-attention` does: the exact conversation token, two samples, no frozen executable.
const unproved = { ready: false, code: "claude_auto_identity_required" };

describe("a banner-less auto-mode Claude with no launch record", () => {
  it("is proved by the real binding and the exact conversation token, and says the process proved it", async () => {
    expect(await seat().adapter.checkReady(real, { resumeToken: token })).toEqual({ ready: true, provedWithoutLaunch: true });
  });

  it("is proved without a frozen executable, as clear-attention proves it", async () => {
    // The wrapper case: argv[0] is the binary's install path, which no frozen path could have named.
    const { adapter, set } = seat();
    set(rowsWith({ command: `/elsewhere/claude --permission-mode auto --resume ${token} --name ${name}` }));
    expect((await adapter.checkReady(real, { resumeToken: token })).ready).toBe(true);
  });

  it("is not proved without the token, as before", async () => {
    expect(await seat().adapter.checkReady(real)).toMatchObject(unproved);
    expect(await seat().adapter.checkReady(real, { resumeToken: null })).toMatchObject(unproved);
    expect(await seat().adapter.checkReady(real, { resumeToken: "" })).toMatchObject(unproved);
  });

  it("is not proved by the stand-in binding with no pane, even with the token", async () => {
    expect(await seat().adapter.checkReady(standIn, { resumeToken: token })).toMatchObject(unproved);
  });

  const stays: [string, Parameters<typeof seat>[0] & { rows?: Partial<NativeProcessRow>; token?: string }][] = [
    ["a wrong token", { token: "other-token" }],
    ["a process naming another conversation", { rows: { command: `${binary} --permission-mode auto --resume other --name ${name}` } }],
    ["a process with no conversation token", { rows: { command: `${binary} --permission-mode auto --name ${name}` } }],
    ["a Claude outside the foreground group", { rows: { pgid: 88 } }],
    ["two panes in the session", { panes: [{ id: "%1" }, { id: "%2" }] }],
    ["a session whose only pane is another", { panes: [{ id: "%2" }] }],
    ["a pane whose PID changes after the observation", { panePid: (target: string) => target === name ? 105 : 100 }],
  ];
  it.each(stays)("stays flagged for %s", async (_name, opts) => {
    const { adapter, set } = seat(opts);
    if (opts.rows) set(rowsWith(opts.rows));
    expect(await adapter.checkReady(real, { resumeToken: opts.token ?? token })).toMatchObject(unproved);
  });

  it("stays flagged when the process changes between the two samples", async () => {
    const { adapter, listProcesses } = seat();
    let reads = 0;
    listProcesses.mockImplementation(async () => rowsWith(reads++ === 0 ? {} : { pid: 103 }));
    expect(await adapter.checkReady(real, { resumeToken: token })).toMatchObject(unproved);
  });

  it("changes nothing when the observation is inconclusive: an unreadable or empty process list", async () => {
    const { adapter, listProcesses } = seat();
    listProcesses.mockRejectedValue(new Error("ps unavailable"));
    expect(await adapter.checkReady(real, { resumeToken: token })).toMatchObject(unproved);
    listProcesses.mockImplementation(async () => []);
    expect(await adapter.checkReady(real, { resumeToken: token })).toMatchObject(unproved);
  });

  // #1553's "absent" reading (a readable process list with no Claude in it) belongs to a fresh in-place launch's own record.
  // Here it is not proof: the no-launch proof needs a process that names the exact conversation.
  it("is not proved by a readable process list with no Claude in it", async () => {
    const { adapter, listProcesses } = seat();
    listProcesses.mockImplementation(async () => rowsWith().slice(0, 2));
    expect(await adapter.checkReady(real, { resumeToken: token })).toMatchObject(unproved);
  });

  it("keeps today's result when a launch record exists for a different launch", async () => {
    const { adapter } = seat();
    await adapter.launchHarness({ ...real, id: "another-binding" }, { name });
    expect(await adapter.checkReady(real, { resumeToken: token })).toMatchObject(unproved);
  });

  // The record says B; Claude continued A as B, and the process on the pane still names A. clear-attention passes the
  // rotation recorded with B, so the sweepers do too.
  it("is proved for a seat whose conversation rotated, by the stored rotation", async () => {
    const { adapter } = seat();
    expect((await adapter.checkReady(real, { resumeToken: rotatedToken, resumeRotation: rotation })).ready).toBe(true);
  });

  it("is not proved for a rotated seat when no rotation is passed", async () => {
    expect(await seat().adapter.checkReady(real, { resumeToken: rotatedToken })).toMatchObject(unproved);
  });

  it.each([
    ["a rotation recorded by another process", { token, process: { ...rotation.process, pid: 103 } }],
    ["a rotation recorded at another start time", { token, process: { ...rotation.process, startedAt: "Mon Oct 19 09:00:09 2026" } }],
    ["a rotation from a conversation the process does not name", { token: "other", process: rotation.process }],
  ])("stays flagged for %s", async (_name, resumeRotation) => {
    expect(await seat().adapter.checkReady(real, { resumeToken: rotatedToken, resumeRotation })).toMatchObject(unproved);
  });

  it("does not let a rotation excuse a seat whose process names neither conversation", async () => {
    const { adapter, set } = seat();
    set(rowsWith({ command: `${binary} --permission-mode auto --resume other --name ${name}` }));
    expect(await adapter.checkReady(real, { resumeToken: rotatedToken, resumeRotation: rotation })).toMatchObject(unproved);
  });

  it("still needs no token when the screen is already recognised", async () => {
    const { adapter, tmux } = seat();
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("Claude Code v2.1.303\n" + autoScreen);
    expect(await adapter.checkReady(real)).toEqual({ ready: true });
    expect(await adapter.checkReady(real, { resumeToken: token })).toEqual({ ready: true });
  });
});
