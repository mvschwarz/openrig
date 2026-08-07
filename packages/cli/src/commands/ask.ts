import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { resolveIdentitySource } from "./whoami.js";
import { runWake, defaultWakeRunner, defaultWakeFileLocator, type WakeRunner } from "../ask-wake.js";

interface AskRigInfo {
  name: string;
  status: string;
  nodeCount: number;
  runningCount: number;
  uptime: string | null;
}

interface AskSeatEvidence {
  name: string;
  generations: number;
  hits: Array<{ generation: number; text: string }>;
  degraded?: { reason: string; message: string };
  advisory?: string;
}

interface AskSessionEvidence {
  token: string;
  found: boolean;
  path?: string;
  excerpts: string[];
  degraded?: { reason: string; message: string };
  advisory?: string;
}

interface CliKnownTenure {
  generation: number;
  sessionId: number;
  tokenPresent: boolean;
  createdAt: string;
}

type WakeResolution =
  | { resolved: true; token: string; runtime: "claude" | "codex"; sessionId: number }
  | { resolved: false; reason: string; known: CliKnownTenure[] };

/** Parse a --wake seat target with an optional trailing @<generation>. A seat is
 *  `member@rig` (one @); `member@rig@2` means generation 2. Only a purely-numeric
 *  final @-segment is treated as the generation. */
function parseSeatGen(target: string): { seat: string; generation?: number } {
  const parts = target.split("@");
  const last = parts[parts.length - 1]!;
  if (parts.length >= 3 && /^\d+$/.test(last)) {
    return { seat: parts.slice(0, -1).join("@"), generation: Number(last) };
  }
  return { seat: target };
}

interface AskResult {
  question: string;
  rig: AskRigInfo | null;
  evidence: {
    backend: string;
    excerpts: string[];
    chatExcerpts?: string[];
  };
  seat?: AskSeatEvidence;
  session?: AskSessionEvidence;
  insufficient: boolean;
  guidance?: string;
}

interface AskCommandDeps extends StatusDeps {
  identityResolver?: typeof resolveIdentitySource;
  wakeRunner?: WakeRunner;
  wakeFileLocator?: (token: string) => { path: string; sizeBytes: number } | null;
}

export function askCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("ask")
    .description("Search rig transcript history with a natural language question")
    .argument("<rig>", "Rig name to search")
    .argument("<question>", "Question to search for in transcripts")
    .option("--json", "JSON output for agents")
    .option("--seat <session-name>", "Scope the search to ONE seat's transcript across every generation that sat in it (cross-generation archaeology)")
    .option("--session <token>", "Search ONE specific session's JSONL by its session token (read-only)")
    .option("--wake <seat[@gen]|token>", "EXECUTES: wake a session (by seat[@generation] or raw resume token) — ask one question, get a snapshot answer, back to cold (runtime cost; explicit, never an implicit escalation from a search)")
    .option("--runtime <runtime>", "runtime for --wake: claude (default) or codex")
    .option("--wake-timeout <seconds>", "bounded wake timeout in seconds (default 180)")
    .addHelpText("after", `
rig ask is one verb for information about the PAST, three ways to reach it:
  1. rig ask <rig> "<q>"                    search the whole rig's transcripts
  2. rig ask <rig> "<q>" --seat <seat>      scope to ONE seat, across every
                                            generation that sat in it (L1, read-only)
  3. rig ask <rig> "<q>" --session <token>  search ONE session's JSONL by
                                            token — "I have the token, find it" (L2, read-only)
  4. rig ask <rig> "<q>" --wake <seat[@gen]|token>
                                            WAKE that session (by seat[@generation]
                                            or raw token), ask, get a snapshot
                                            answer, back to cold (L3, EXECUTES)

Levels 1-2 are read-only archaeology (cheap, safe). Level 3 (--wake) EXECUTES an
agent — the only level with runtime cost. The answer is snapshot testimony:
checked, not believed.

Examples:
  rig ask my-rig "what decisions were made about deployment?"
  rig ask my-rig "what did we decide" --seat dev-planner@my-rig
  rig ask my-rig "SECRET_MARKER" --session 3f2a-...-9c1
  rig ask my-rig "summarize the gateway plan" --wake 3f2a-...-9c1

Exit codes:
  0  Success
  1  Daemon not running
  2  Failed to fetch data from daemon (or wake timed out)`);

  const getDeps = (): AskCommandDeps => (depsOverride as AskCommandDeps | undefined) ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd.action(async (rig: string, question: string, opts: { json?: boolean; seat?: string; session?: string; wake?: string; runtime?: string; wakeTimeout?: string }) => {
    const deps = getDeps();

    // L3 — WAKE: EXECUTES the runtime headless. A raw token wakes CLI-locally; a
    // seat[@gen] target is resolved to a token via the daemon first. Explicit
    // --wake only — never an implicit escalation from a failed L1/L2 search, and
    // an unresolvable seat REFUSES with teaching (never a guessed wake).
    if (opts.wake) {
      const target = opts.wake;
      const timeoutMs = opts.wakeTimeout ? Math.max(1, Number(opts.wakeTimeout)) * 1000 : undefined;

      let token = target;
      let runtime: "claude" | "codex" = opts.runtime === "codex" ? "codex" : "claude";

      if (target.includes("@")) {
        const status = await getDaemonStatus(deps.lifecycleDeps);
        if (status.state !== "running" || status.healthy === false) {
          console.error("Daemon not running (needed to resolve a seat). Start it with: rig daemon start — or pass a raw session token to --wake.");
          process.exitCode = 1;
          return;
        }
        const client = deps.clientFactory(getDaemonUrl(status));
        const { seat, generation } = parseSeatGen(target);
        const res = await client.post<WakeResolution>("/api/wake-resolve", { seat, generation });
        if (res.status >= 400) {
          console.error(`Failed to resolve seat (HTTP ${res.status}). Check daemon status with: rig status`);
          process.exitCode = 2;
          return;
        }
        const resolution = res.data;
        if (!resolution.resolved) {
          console.error(resolution.reason);
          if (resolution.known && resolution.known.length > 0) {
            console.error("Known tenures for this seat (newest first):");
            for (const t of resolution.known) {
              console.error(`  gen ${t.generation}: session ${t.sessionId}${t.tokenPresent ? "" : " (no resume token)"}  ${t.createdAt}`);
            }
          }
          process.exitCode = 2;
          return;
        }
        token = resolution.token;
        runtime = resolution.runtime;
      }

      const runner = deps.wakeRunner ?? defaultWakeRunner;
      const fileLocator = deps.wakeFileLocator ?? defaultWakeFileLocator;
      const outcome = await runWake({ runner, fileLocator }, { question, token, runtime, timeoutMs });

      if (opts.json) {
        console.log(JSON.stringify(outcome));
        if (outcome.timedOut || outcome.failed) process.exitCode = 2;
        return;
      }
      if (outcome.advisory) console.log(`⚠ ${outcome.advisory}`);
      if (outcome.timedOut || outcome.failed) {
        console.error(outcome.message);
        process.exitCode = 2;
        return;
      }
      console.log(`Woke ${runtime} session ${target} — snapshot answer (checked, not believed):`);
      console.log("");
      console.log(outcome.answer && outcome.answer.length > 0 ? outcome.answer : "(no answer returned)");
      return;
    }

    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return;

    const client = deps.clientFactory(getDaemonUrl(status));
    const identity = (deps.identityResolver ?? resolveIdentitySource)({});
    const res = await client.post<AskResult>("/api/ask", {
      rig,
      question,
      nodeId: identity?.nodeId,
      sessionName: identity?.sessionName,
      seat: opts.seat,
      session: opts.session,
    });

    if (res.status >= 400) {
      console.error(`Failed to query rig (HTTP ${res.status}). Check daemon status with: rig status`);
      process.exitCode = 2;
      return;
    }

    const result = res.data;

    if (opts.json) {
      console.log(JSON.stringify(result));
      return;
    }

    // Human-readable output
    console.log(`Question: ${result.question}`);
    console.log("");

    if (result.rig) {
      console.log(`Rig: ${result.rig.name}  [${result.rig.status}]  ${result.rig.runningCount}/${result.rig.nodeCount} nodes  uptime: ${result.rig.uptime ?? "—"}`);
    } else {
      console.log(`Rig: ${rig}  [not found]`);
    }

    if (result.seat) {
      console.log(`Seat: ${result.seat.name}  (${result.seat.generations} generation(s) searched)`);
      if (result.seat.advisory) {
        console.log(`  ⚠ ${result.seat.advisory}`);
      }
    }

    if (result.session) {
      const loc = result.session.found ? (result.session.path ?? "found") : "not found";
      console.log(`Session: ${result.session.token}  [${loc}]`);
      if (result.session.advisory) {
        console.log(`  ⚠ ${result.session.advisory}`);
      }
    }

    console.log(`Search: ${result.evidence.backend}`);
    console.log("");

    if (result.guidance) {
      console.log(result.guidance);
      console.log("");
    }

    if (result.evidence.excerpts.length > 0) {
      const heading = result.evidence.backend === "structured"
        ? `Structured Answer (${result.evidence.excerpts.length} items):`
        : `Transcript Evidence (${result.evidence.excerpts.length} matches):`;
      console.log(heading);
      for (const excerpt of result.evidence.excerpts) {
        console.log(`  - ${excerpt}`);
      }
    }

    if (result.evidence.chatExcerpts && result.evidence.chatExcerpts.length > 0) {
      if (result.evidence.excerpts.length > 0) {
        console.log("");
      }
      console.log(`Chat Evidence (${result.evidence.chatExcerpts.length} matches):`);
      for (const excerpt of result.evidence.chatExcerpts) {
        console.log(`  - ${excerpt}`);
      }
    }

    if (
      result.evidence.excerpts.length === 0 &&
      (!result.evidence.chatExcerpts || result.evidence.chatExcerpts.length === 0) &&
      !result.guidance
    ) {
      console.log("No transcript evidence found.");
    }
  });

  return cmd;
}
