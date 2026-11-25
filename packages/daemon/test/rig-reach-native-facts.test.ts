import { describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { codexRigReach, codexRigReachWarning, validateCodexMemberPermissions } from "../src/domain/codex-member-permissions.js";
import { seatRigReachPaths } from "../src/domain/seat-launch-environment.js";

// Independent native0.171 Linux controls are retained in the QA packet; this check must not guess native expansion.
const paths = { openrigHome: "/home/qa/.openrig", rigInstall: "/home/qa/cli", node: "/usr/bin/node",
  home: "/home/qa", cwd: "/work/qa", tmpdir: "/home/qa/qa-tmp" };
const policy = (filesystem: Record<string, "read" | "write" | "deny">) =>
  validateCodexMemberPermissions({ approval: "never", filesystem, network_access: true });

describe("rig reach: observed gaps versus unexpanded native policy", () => {
  it("recognizes the declared TMPDIR grant instead of warning about a readable OpenRig home", () => {
    expect(codexRigReach(policy({ ":minimal": "read", ":tmpdir": "read", ":workspace_roots": "write", "/usr/bin": "read" }),
      { ...paths, openrigHome: paths.tmpdir, rigInstall: paths.cwd })).toBeNull();
  });

  it("does not assume minimal means every nonhome system path is readable", () => {
    expect(codexRigReach(policy({ ":minimal": "read", ":workspace_roots": "write", "/usr/bin": "read" }),
      { ...paths, openrigHome: paths.cwd, rigInstall: "/var/lib/openrig" })).toEqual({
      unreadable: [], network: "on", unverified: [{ what: "the rig install", path: "/var/lib/openrig" }],
    });
  });

  it("does not promise a narrower read punches through a denied ancestor", () => {
    expect(codexRigReach(policy({ ":root": "read", "/home/qa": "deny", "/home/qa/.openrig": "read", "/home/qa/cli": "read" }), paths)).toEqual({
      unreadable: [], network: "on", unverified: [
        { what: "the OpenRig home", path: paths.openrigHome }, { what: "the rig install", path: paths.rigInstall },
      ],
    });
  });

  it("checks the exact paired entry, not only its readable installation directory", () => {
    const rigEntry = "/home/qa/cli/dist/bin-wrapper.js";
    expect(codexRigReach(policy({ ":root": "read", [rigEntry]: "deny" }), { ...paths, rigEntry })).toEqual({
      unreadable: [{ what: "the rig install", path: rigEntry }], network: "on",
    });
  });

  it("checks the exact seat alias, not only its readable OpenRig directory", () => {
    const rigAlias = "/home/qa/.openrig/run/seat-bin/current/rig";
    expect(codexRigReach(policy({ ":root": "read", [rigAlias]: "deny" }), { ...paths, rigAlias })).toEqual({
      unreadable: [{ what: "the OpenRig home", path: rigAlias }], network: "on",
    });
  });

  it("uses the exact Node binary plus the seat's declared home and TMPDIR", () => {
    const found = seatRigReachPaths({ HOME: "/home/qa", TMPDIR: "/home/qa/qa-tmp" });
    expect(found.node).toBe(realpathSync(process.execPath));
    expect(found.home).toBe("/home/qa");
    expect(found.tmpdir).toBe("/home/qa/qa-tmp");
  });

  it("keeps the daemon's node conditional when the seat's rig runs on another node", () => {
    // The daemon runs on /opt/daemon-node; the seat's PATH finds /usr/bin/node, which :root covers. Only the daemon's is denied.
    const daemonNode = "/opt/daemon-node/bin/node";
    const gap = codexRigReach(policy({ ":root": "read", "/opt/daemon-node": "deny" }), { ...paths, node: daemonNode });
    expect(gap).toEqual({ unreadable: [], network: "on", unverified: [{ what: "node", path: daemonNode }] });
    const text = codexRigReachWarning("dev.qa", gap!, "linux");
    expect(text).not.toContain("can't run rig");
    expect(text).not.toContain("To fix it");
    expect(text).not.toMatch(/add (that|those) paths? with read access/);
    expect(text).toBe("dev.qa: this seat's codex_permissions read coverage is not verified. The permissions don't show that the"
      + ` seat can read node (${daemonNode}), the one this daemon runs on. In the seat, rig runs on the first node on the seat's`
      + " PATH, which may be another one; if it's this one, the seat needs to read it too. Run rig whoami inside the seat to"
      + " check; do not change a working policy just for this advisory. The launch continues with the permissions as written.");
  });

  it("keeps a known broad read quiet even with a redundant minimal read", () => {
    expect(codexRigReach(policy({ ":root": "read", ":minimal": "read" }), paths)).toBeNull();
  });

  it("does not choose a conflicting root alias by object insertion order", () => {
    const first = codexRigReach(policy({ ":root": "read", "/": "deny" }), paths);
    const second = codexRigReach(policy({ "/": "deny", ":root": "read" }), paths);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ unreadable: [], unverified: expect.any(Array) });
  });

  it("names uncertainty without declaring a working profile broken or asking to broaden it", () => {
    const text = codexRigReachWarning("dev.qa", { unreadable: [], network: "on",
      unverified: [{ what: "node", path: "/opt/custom-node" }] });
    expect(text).toContain("read coverage is not verified");
    expect(text).not.toContain("can't run rig");
    expect(text).toContain("do not change a working policy");
    expect(text).toContain("Run rig whoami inside the seat");
    expect(text).toContain("The launch continues with the permissions as written.");
  });
});
