// Native process observation must not depend on the daemon's inherited locale.
// `ps` formats lstart through LC_TIME, so a non-English locale used to make every
// row fail the parser and both listers returned []. This drives the REAL listers
// (real execFile, real child environment) against a hermetic `ps` that formats
// its date the way the effective locale would: LC_ALL, then LC_TIME, then LANG.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listNativeProcesses } from "../src/domain/native-process-lineage.js";
import { defaultListProcessesStrict } from "../src/domain/resume-metadata-refresher.js";

const ENGLISH_START = "Wed Sep 30 21:44:48 2026";
const MARKER = "synthetic-unrelated-marker";

let scratch: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function installLocaleAwarePs(): string {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "native-ps-locale-"));
  const envLog = path.join(scratch, "child-env.txt");
  fs.writeFileSync(path.join(scratch, "ps"), [
    "#!/bin/sh",
    `/usr/bin/env > '${envLog}'`,
    'effective="${LC_ALL:-${LC_TIME:-$LANG}}"',
    'case "$effective" in',
    `  ""|C|C.*|POSIX|en_*) started="${ENGLISH_START}" ;;`,
    '  *) started="Mi 30 Sep 21:44:48 2026" ;;',
    "esac",
    'case "$2" in',
    '  *ucomm*) printf \'%s\\n\' "PID PPID PGID TPGID UCOMM STARTED COMMAND" "101 1 101 101 codex $started codex resume tok-1 $OPENRIG_PS_MARKER" "102 1 102 102 zsh $started -zsh" ;;',
    '  *) printf \'%s\\n\' "PID PPID STARTED COMMAND" "101 1 $started codex resume tok-1 $OPENRIG_PS_MARKER" "102 1 $started -zsh" ;;',
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  vi.stubEnv("PATH", scratch);
  vi.stubEnv("OPENRIG_PS_MARKER", MARKER);
  return envLog;
}

const INHERITED_LOCALES: Array<{ name: string; LC_ALL?: string; LC_TIME?: string; LANG?: string }> = [
  { name: "LANG=de_DE.UTF-8", LANG: "de_DE.UTF-8" },
  { name: "LC_TIME=fr_FR.UTF-8 over LANG=en_US.UTF-8", LC_TIME: "fr_FR.UTF-8", LANG: "en_US.UTF-8" },
  { name: "LC_ALL=ja_JP.UTF-8", LC_ALL: "ja_JP.UTF-8" },
];

const LISTERS = [
  ["listNativeProcesses", listNativeProcesses],
  ["defaultListProcessesStrict", defaultListProcessesStrict],
] as const;

describe.each(LISTERS)("%s under an inherited non-English locale", (_name, list) => {
  for (const locale of INHERITED_LOCALES) {
    it(`keeps every row under ${locale.name}, with a child-only C locale`, async () => {
      const envLog = installLocaleAwarePs();
      vi.stubEnv("LC_ALL", locale.LC_ALL);
      vi.stubEnv("LC_TIME", locale.LC_TIME);
      vi.stubEnv("LANG", locale.LANG);

      const rows = await list();

      expect(rows.map((row) => row.pid)).toEqual([101, 102]);
      expect(rows.every((row) => row.startedAt === ENGLISH_START)).toBe(true);
      expect(rows[0]!.command).toBe(`codex resume tok-1 ${MARKER}`);

      const childEnv = fs.readFileSync(envLog, "utf8").split("\n");
      expect(childEnv).toContain("LC_ALL=C");
      expect(childEnv).toContain(`OPENRIG_PS_MARKER=${MARKER}`);
      expect(childEnv).toContain(`PATH=${scratch}`);

      // The override is child-only: the daemon's own environment is untouched.
      expect(process.env.LC_ALL).toBe(locale.LC_ALL);
      expect(process.env.LC_TIME).toBe(locale.LC_TIME);
      expect(process.env.LANG).toBe(locale.LANG);
    });
  }
});
