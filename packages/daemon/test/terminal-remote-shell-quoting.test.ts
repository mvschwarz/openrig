import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { composeView } from "../src/domain/terminal/view-composer.js";

it("keeps remote session names intact through both POSIX shell boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "openrig-remote-shell-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Simulate ssh's remote-command reconstruction. The local and remote shell
  // parsing are real; no SSH server or terminal provider is claimed here.
  writeFileSync(join(bin, "ssh"), '#!/bin/sh\nshift\nexec /bin/sh -c "$*"\n', { mode: 0o700 });
  writeFileSync(join(bin, "tmux"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$OPR_ARGS"\n', { mode: 0o700 });
  const argsFile = join(root, "args");
  try {
    for (const session of ["seat-normal", "seat space", "seat'quote"]) {
      for (const readOnly of [false, true]) {
        const view = composeView("fixture", [{
          seat: session, label: session, tmuxSession: session, host: "edge", readOnly, alive: true,
        }], { resolveHost: () => ({ id: "edge", transport: "ssh", target: "fixture" }) });
        execFileSync("/bin/sh", ["-c", view.opened[0]!.paneCommand], {
          env: { PATH: `${bin}:/usr/bin:/bin`, OPR_ARGS: argsFile },
        });
        expect(readFileSync(argsFile, "utf8").trimEnd().split("\n")).toEqual([
          "attach", ...(readOnly ? ["-r"] : []), "-t", session,
        ]);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
