import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import os from "node:os";
import type { ResolvedStartupFile } from "./runtime-adapter.js";

/**
 * Daemon-side productized resolver for the Agent Starter v1 vertical (M1).
 * Mirrors the v0 wrapper-tier `bin/agent-starter-resolve` semantics:
 * read the named registry entry; run the path-aware no-credentials scan;
 * THROW on a failed scan (the orchestrator MUST treat any throw as a
 * hard launch failure — see review-independent finding 2 in the slice
 * IMPL); on a clean scan, emit a `ResolvedStartupFile[]` rooted at the
 * registry directory.
 *
 * v0 wrapper references:
 * - Schema spec: `specs/agent-starters/SCHEMA.md` § No-Credentials Proof
 *   (path-aware + content-aware; allowlist for transcript_path under
 *   ~/.claude/projects/ or ~/.openrig/transcripts/).
 * - Refusal verb: `specs/agent-starters/bin/agent-starter-resolve` lines
 *   22-31 (preflights via `scan_starter_file`; refuses with
 *   credential_path_disallowed / credential_content_disallowed).
 *
 * Pattern reference for the resolver shape:
 * `session-source-rebuild-resolver.ts:31-90`.
 */

export type ExistsFn = (path: string) => boolean;
export type ReadFileFn = (path: string) => string;

export interface AgentStarterResolverOpts {
  /** Optional absolute override; bypasses the lookup chain. */
  registryRoot?: string;
  /**
   * Env var consulted second in the lookup chain. Defaults to
   * `OPENRIG_AGENT_STARTER_ROOT`.
   */
  envVarName?: string;
  /**
   * Home-directory root consulted third. Defaults to
   * `~/.openrig/agent-starters/` (resolved against `process.env.HOME` or
   * `os.homedir()`).
   */
  homeDirRoot?: string;
  /**
   * Substrate fallback consulted last for dogfood proofs. Defaults to
   * the v0 prototype location at
   * `~/code/substrate/shared-docs/openrig-work/specs/agent-starters/`.
   */
  substrateFallback?: string;
  exists?: ExistsFn;
  readFile?: ReadFileFn;
  /** Test seam: lets unit tests inject a controlled env map. */
  env?: Record<string, string | undefined>;
}

export interface AgentStarterResolveResult {
  files: ResolvedStartupFile[];
  registryPath: string;
}

/**
 * Thrown by `resolveStarter` when the no-credentials scan fails. Per
 * review-independent finding 2, the resolver MUST throw rather than
 * return a structured "ok: false" result the orchestrator could ignore;
 * a failed scan is a hard refusal point that aborts the launch.
 */
export class AgentStarterCredentialScanFailedError extends Error {
  readonly starterName: string;
  readonly reason: string;
  constructor(starterName: string, reason: string) {
    super(`Agent Starter "${starterName}" credential scan failed: ${reason}`);
    this.name = "AgentStarterCredentialScanFailedError";
    this.starterName = starterName;
    this.reason = reason;
  }
}

const DEFAULT_ENV_VAR = "OPENRIG_AGENT_STARTER_ROOT";
const DEFAULT_HOME_SUBPATH = ".openrig/agent-starters";
const DEFAULT_SUBSTRATE_FALLBACK =
  "/Users/wrandom/code/substrate/shared-docs/openrig-work/specs/agent-starters";

export class AgentStarterResolver {
  private readonly registryRoot: string;
  private readonly exists: ExistsFn;
  private readonly readFile: ReadFileFn;

  constructor(opts: AgentStarterResolverOpts = {}) {
    this.exists = opts.exists ?? existsSync;
    this.readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
    this.registryRoot = AgentStarterResolver.resolveRegistryRoot(opts, this.exists);
  }

  /** Exposed for tests + diagnostics. */
  getRegistryRoot(): string {
    return this.registryRoot;
  }

  /**
   * Look up the registry root via the documented chain:
   *   opts.registryRoot > env[envVarName] > homeDirRoot (if exists) > substrateFallback
   *
   * The first three are explicit; the substrate fallback is the dogfood
   * default and always returns even if the path doesn't exist (resolveStarter
   * will throw with a missing-entry error when the fallback is dead). This
   * keeps the constructor side-effect-free; the file-existence check lives
   * inside `resolveStarter`.
   */
  static resolveRegistryRoot(
    opts: AgentStarterResolverOpts,
    exists: ExistsFn,
  ): string {
    if (typeof opts.registryRoot === "string" && opts.registryRoot !== "") {
      return opts.registryRoot;
    }
    const env = opts.env ?? process.env;
    const envVarName = opts.envVarName ?? DEFAULT_ENV_VAR;
    const fromEnv = env[envVarName];
    if (typeof fromEnv === "string" && fromEnv !== "") {
      return fromEnv;
    }
    const homeBase = opts.homeDirRoot
      ?? join(env.HOME ?? os.homedir(), DEFAULT_HOME_SUBPATH);
    if (exists(homeBase)) {
      return homeBase;
    }
    return opts.substrateFallback ?? DEFAULT_SUBSTRATE_FALLBACK;
  }

  /**
   * Resolve a starter by registry name. THROWS on:
   * - missing registry entry (no `<root>/<name>.yaml`);
   * - malformed YAML (best-effort detection — empty file, unparseable
   *   front-matter shape — driver does not pull in a YAML parser at
   *   M1 to keep the dependency surface narrow);
   * - failed no-credentials scan (`AgentStarterCredentialScanFailedError`).
   *
   * On a clean scan, emits `ResolvedStartupFile[]`. v1 M1 scaffolding
   * shape: one entry per registry-relative file the starter declares
   * (currently the registry entry YAML itself, treated as guidance_merge
   * content; later milestones can extend the resolver to walk the
   * priming-pack manifest's `read_full` paths once M2/M3 wiring is in
   * place). All emitted files are tagged `appliesOn: ["fresh_start"]`
   * because starter context seeds a fresh-launch conversation.
   */
  resolveStarter(name: string): AgentStarterResolveResult {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
      throw new Error(
        `Agent Starter resolver: invalid name ${JSON.stringify(name)} (must be alphanumeric with optional "_" or "-")`,
      );
    }
    const registryPath = join(this.registryRoot, `${name}.yaml`);
    if (!this.exists(registryPath)) {
      throw new Error(
        `Agent Starter resolver: no registry entry found at ${registryPath}`,
      );
    }
    let content: string;
    try {
      content = this.readFile(registryPath);
    } catch (err) {
      throw new Error(
        `Agent Starter resolver: failed to read ${registryPath}: ${(err as Error).message}`,
      );
    }
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error(
        `Agent Starter resolver: ${registryPath} is empty or unreadable`,
      );
    }
    // Smoke check that the file parses as YAML front-matter shape: it must
    // contain `starter_id:` line. Keeps M1 dependency surface narrow (no
    // yaml parser pulled in); M2 can swap in a real parser when it walks
    // the priming-pack manifest.
    if (!/^starter_id:\s*\S+/m.test(content)) {
      throw new Error(
        `Agent Starter resolver: ${registryPath} does not match registry-entry shape (missing "starter_id:" field)`,
      );
    }

    // Path-aware + content-aware credential scan. Mirrors the v0 wrapper
    // helper at `specs/agent-starters/lib/agent-starter-helpers.sh`
    // `scan_starter_file`. THROWS on match (per finding 2: refuse, do
    // not return).
    const scanResult = scanForCredentials(content, registryPath);
    if (!scanResult.ok) {
      throw new AgentStarterCredentialScanFailedError(name, scanResult.reason);
    }

    // M1 scaffolding shape: one ResolvedStartupFile pointing at the
    // registry entry itself. The orchestrator's `deliverStartup` seam
    // already accepts `deliveryHint: "guidance_merge"`. Later milestones
    // (M2 instantiator integration; M3 Claude e2e; M4 Codex parity) can
    // extend the resolver to walk the priming-pack manifest's `read_full`
    // paths if the e2e proof requires richer per-layer artifacts. The
    // type contract and refusal semantics are what M1 is locking in.
    const files: ResolvedStartupFile[] = [
      {
        path: basename(registryPath),
        absolutePath: registryPath,
        ownerRoot: this.registryRoot,
        deliveryHint: "guidance_merge",
        required: true,
        appliesOn: ["fresh_start"],
      },
    ];

    return { files, registryPath };
  }
}

// --- No-credentials scan (mirrors `lib/agent-starter-helpers.sh::scan_starter_file`) ---

const CRED_PATH_LITERALS = [
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".aws/credentials",
  ".ssh/",
];

const CRED_PATH_RE = /(credentials|auth\.json|secrets|tokens?\.json)([^a-zA-Z0-9._-]|$)/;
const CRED_STRING_RE = /(api[_-]?key|secret[_-]?key|bearer[_-]?token|sk-[A-Za-z0-9]{20,}|gh[ps]_[A-Za-z0-9]{20,}|password[\s]*[:=])/i;

function scanForCredentials(
  content: string,
  filePath: string,
): { ok: true } | { ok: false; reason: string } {
  // Allowlist exception: `transcript_path` field values under
  // `~/.claude/projects/` or `~/.openrig/transcripts/` are accepted
  // (mirrors the v0 wrapper); same paths under any other field/key/comment
  // are rejected as suspicious copying.
  const transcriptPath = extractFieldValue(content, "transcript_path");

  let lineNo = 0;
  for (const rawLine of content.split("\n")) {
    lineNo += 1;
    const line = rawLine;

    // Allowlist check for transcript_path's own line.
    const stripped = line.replace(/^\s+/, "");
    let isAllowlistedTranscript = false;
    if (transcriptPath && stripped.startsWith("transcript_path:")) {
      if (
        transcriptPath.includes("/.claude/projects/")
        || transcriptPath.includes("/.openrig/transcripts/")
      ) {
        isAllowlistedTranscript = true;
      }
    }

    // 1. Literal credential paths.
    for (const literal of CRED_PATH_LITERALS) {
      if (line.includes(literal)) {
        return {
          ok: false,
          reason: `credential_path_disallowed: line ${lineNo} of ${filePath} contains credential path ${JSON.stringify(literal)} (line: ${JSON.stringify(line)})`,
        };
      }
    }

    // 2. Path regex (credentials|auth.json|secrets|tokens.json).
    if (!isAllowlistedTranscript && CRED_PATH_RE.test(line)) {
      return {
        ok: false,
        reason: `credential_path_disallowed: line ${lineNo} of ${filePath} matches credential path pattern (line: ${JSON.stringify(line)})`,
      };
    }

    // 3. Credential string regex (case-insensitive).
    if (CRED_STRING_RE.test(line)) {
      return {
        ok: false,
        reason: `credential_content_disallowed: line ${lineNo} of ${filePath} matches credential content pattern (line: ${JSON.stringify(line)})`,
      };
    }
  }

  return { ok: true };
}

function extractFieldValue(content: string, field: string): string {
  const re = new RegExp(`^\\s*${field}:\\s*(.*?)\\s*$`, "m");
  const match = content.match(re);
  if (!match || !match[1]) return "";
  return match[1].replace(/^['"]|['"]$/g, "").trim();
}
