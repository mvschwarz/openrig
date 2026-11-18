import { describe, expect, it } from "vitest";
import { encodeTmuxViewerProof, parseTmuxViewerProof, qualifiesTmuxViewer, tmuxViewerCloseArgs } from "../src/domain/terminal/tmux-viewer-guard.js";

const viewer = { sessionId: "$1", sessionName: "openrig-view-fixture", nonce: "fixture:old-nonce.1", windowIds: ["@1", "@2"], paneIds: ["%1", "%2", "%3"] };
const snapshot = "$1|openrig-view-fixture|fixture:old-nonce.1|@1;@2;|%1;%2;%3;|0";

describe("tmux viewer conditional close grammar", () => {
  it("supports non-UUID legacy nonces and checks the full identity and inventories", () => {
    expect(qualifiesTmuxViewer(viewer)).toBe(true);
    const args = tmuxViewerCloseArgs(viewer, snapshot, true)!;
    expect(args.slice(0, 4)).toEqual(["if-shell", "-F", "-t", "$1"]);
    expect(args[4]).toContain("#{==:#{session_attached},0}");
    expect(args[4]).toContain("#{==:#{W:#{window_id};},@1;@2;}");
    expect(args[4]).toContain("#{==:#{W:#{P:#{pane_id};}},%1;%2;%3;}");
    expect(args[5]).toBe("kill-session -t '$1'");
  });

  it.each([
    { sessionId: "$1; kill-server" }, { sessionName: "view,#{pane_id}" },
    { nonce: "nonce},#{pane_id}" }, { nonce: "nonce\nkill-server" }, { nonce: "nonce with space" },
    { nonce: "nonce\n" }, { sessionId: "$1\n" }, { windowIds: ["@1\n"] }, { paneIds: ["%1\n"] },
    { windowIds: ["@1,#{pane_id}"] }, { paneIds: ["%1;kill-server"] },
    { windowIds: ["@1", "@1"] }, { paneIds: [] },
  ])("returns no command for unqualified stored fields %j", changed => {
    expect(tmuxViewerCloseArgs({ ...viewer, ...changed }, snapshot)).toBeNull();
  });

  it.each([
    "$2|openrig-view-fixture|fixture:old-nonce.1|@1;@2;|%1;%2;%3;|0",
    snapshot.replace("openrig-view-fixture", "renamed"), snapshot.replace("fixture:old-nonce.1", "changed"),
    snapshot.replace("@1;@2;", "@1;@2;@3;"), snapshot.replace("%1;%2;%3;", "%1;%2;%3;%4;"),
    snapshot.replace("%1;%2;%3;", "%1;%1;%3;"), snapshot + "|extra",
  ])("returns no command when the snapshot differs: %s", value => {
    expect(tmuxViewerCloseArgs(viewer, value)).toBeNull();
  });

  it("requires no attached client only for failed-launch cleanup", () => {
    const attached = snapshot.slice(0, -1) + "1";
    expect(tmuxViewerCloseArgs(viewer, attached, true)).toBeNull();
    expect(tmuxViewerCloseArgs(viewer, attached)).not.toBeNull();
  });
});

it("binds the full session-option proof to the conditional command", () => {
  const value = { ...viewer, view: "rig:stable-id", endpoint: 'tmux:["-L","fixture"]' };
  const encoded = encodeTmuxViewerProof(value);
  expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual({ version: 1, ...value });
  const parsed = parseTmuxViewerProof(encoded)!;
  expect(parsed).toEqual({ ...value, proof: encoded });
  const args = tmuxViewerCloseArgs(parsed, snapshot + "|" + encoded)!;
  expect(args[4]).toContain(`#{==:#{@openrig_rig_viewer_proof},${encoded}}`);
  expect(tmuxViewerCloseArgs(parsed, snapshot + "|changed")).toBeNull();
  expect(tmuxViewerCloseArgs(parsed, snapshot)).toBeNull();
});

it.each(["", "not valid", Buffer.from('{"version":2}').toString("base64url"),
  Buffer.from(JSON.stringify({ version: 1, ...viewer, paneIds: ["%1;kill-server"], view: "rig:a", endpoint: "tmux:[]" })).toString("base64url")
])("rejects incomplete or unsafe session option proof %j", value => {
  expect(parseTmuxViewerProof(value)).toBeNull();
});
