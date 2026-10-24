import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { composeView } from "../src/domain/terminal/view-composer.js";

it.each(["inherit", "isolated"] as const)("keeps remote session names intact through both POSIX shell boundaries in %s mode", (mode) => {
  const root = mkdtempSync(join(tmpdir(), "openrig-remote-shell-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Simulate ssh's remote-command reconstruction. The local and remote shell
  // parsing are real; no SSH server or terminal provider is claimed here.
  writeFileSync(join(bin, "ssh"), '#!/bin/sh\n[ "$1" = -t ] || exit 64\nshift 2\nexec /bin/sh -c "$*"\n', { mode: 0o700 });
  // An inherited tile must work even when the remote PATH contains only tmux.
  writeFileSync(join(bin, "tmux"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$OPR_ARGS"\n', { mode: 0o700 });
  if (mode === "isolated") {
    writeFileSync(join(bin, "rig"), '#!/bin/sh\nprintf "%s\\n" "$OPENRIG_HOST_SELECTED" "$@" > "$OPR_ARGS"\n', { mode: 0o700 });
  }
  const argsFile = join(root, "args");
  try {
    for (const session of ["seat-normal", "seat space", "seat'quote", "-seat-option", "seat$(false)"]) {
      for (const readOnly of [false, true]) {
        const view = composeView("fixture", [{
          seat: session, label: session, tmuxSession: session, host: "edge", readOnly, alive: true,
        }], { resolveHost: () => ({ id: "edge", transport: "ssh", target: "fixture" }),
          localTmuxServer: ["-S", "/local/only/socket"], localTmuxServerMode: mode });
        execFileSync("/bin/sh", ["-c", view.opened[0]!.paneCommand], {
          env: { PATH: mode === "inherit" ? bin : `${bin}:/usr/bin:/bin`, OPR_ARGS: argsFile, OPENRIG_HOST_SELECTED: "another-host" },
        });
        expect(readFileSync(argsFile, "utf8").trimEnd().split("\n")).toEqual(mode === "isolated"
          ? ["local", "terminal", "attach", ...(readOnly ? ["--read-only"] : []), "--", session]
          : ["attach", ...(readOnly ? ["-r"] : []), "-t", session]);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["missing", "failed"])("does not attach to a namesake when the isolated remote CLI is %s", (failure) => {
  const root = mkdtempSync(join(tmpdir(), "openrig-remote-failure-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const argsFile = join(root, "tmux-args");
  try {
    writeFileSync(join(bin, "ssh"), '#!/bin/sh\n[ "$1" = -t ] || exit 64\nshift 2\nexec /bin/sh -c "$*"\n', { mode: 0o700 });
    symlinkSync("/usr/bin/env", join(bin, "env"));
    writeFileSync(join(bin, "tmux"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$OPR_ARGS"\n', { mode: 0o700 });
    if (failure === "failed") {
      writeFileSync(join(bin, "rig"), "#!/bin/sh\nexit 69\n", { mode: 0o700 });
    }
    const view = composeView("fixture", [{
      seat: "seat@rig", label: "seat", tmuxSession: "seat@rig", host: "edge", readOnly: false, alive: true,
    }], { resolveHost: () => ({ id: "edge", transport: "ssh", target: "fixture" }), localTmuxServerMode: "isolated" });
    const result = spawnSync("/bin/sh", ["-c", view.opened[0]!.paneCommand], {
      env: { PATH: bin, OPR_ARGS: argsFile }, encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(failure === "missing" ? 127 : 69);
    expect(existsSync(argsFile)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
