import nodePath from "node:path";
import { Command } from "commander";
import fs from "node:fs";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { parse as parseYaml } from "yaml";

export interface RigDeps extends StatusDeps {
  readFile: (path: string) => string;
}

export function rigCommand(depsOverride?: RigDeps): Command {
  const cmd = new Command("spec").description("Manage rig specs");
  const getDeps = (): RigDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  };

  cmd
    .command("audit <path>")
    .description("Advisory audit of rig-spec culture and startup context")
    .option("--json", "JSON output")
    .action((filePath: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      let source: string;
      try {
        source = deps.readFile(filePath);
      } catch {
        console.error(`Cannot read file: ${filePath}`);
        process.exitCode = 1;
        return;
      }

      let parsed: unknown;
      try {
        parsed = parseYaml(source);
      } catch (error) {
        console.error(`Cannot audit ${filePath}: invalid YAML (${(error as Error).message})`);
        process.exitCode = 1;
        return;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        console.error(`Cannot audit ${filePath}: rig spec must be a YAML object`);
        process.exitCode = 1;
        return;
      }

      const spec = parsed as Record<string, unknown>;
      const findings: Array<{ kind: string; message: string; typicalFix: string }> = [];
      const cultureFile = typeof spec["culture_file"] === "string" ? spec["culture_file"].trim() : "";
      if (cultureFile === "") {
        findings.push({
          kind: "missing_culture",
          message: "No culture_file is declared.",
          typicalFix: "Author CULTURE.md and add culture_file: CULTURE.md. See the openrig-architect skill's authoring workflow.",
        });
      } else {
        // Slice 16 (item 2): a seat rename in rig.yaml must not leave STALE seat ids
        // in the culture that materializes into each seat's AGENTS.md/CLAUDE.md
        // (misdirects seat-to-seat addressing). Flag any `pod.member` reference in
        // the culture whose pod exists but whose full seat id is not a current seat.
        const knownPods = new Set<string>();
        const knownSeats = new Set<string>();
        const pods = Array.isArray(spec["pods"]) ? (spec["pods"] as Array<Record<string, unknown>>) : [];
        for (const pod of pods) {
          const podId = typeof pod?.["id"] === "string" ? (pod["id"] as string) : null;
          if (!podId) continue;
          knownPods.add(podId);
          const members = Array.isArray(pod["members"]) ? (pod["members"] as Array<Record<string, unknown>>) : [];
          for (const m of members) {
            const mid = typeof m?.["id"] === "string" ? (m["id"] as string) : null;
            if (mid) knownSeats.add(`${podId}.${mid}`);
          }
        }
        const culturePath = nodePath.isAbsolute(cultureFile) ? cultureFile : nodePath.join(nodePath.dirname(filePath), cultureFile);
        let cultureText: string | null = null;
        try { cultureText = deps.readFile(culturePath); } catch { cultureText = null; }
        if (cultureText === null) {
          findings.push({
            kind: "culture_unreadable",
            message: `culture_file '${cultureFile}' is declared but could not be read at ${culturePath}.`,
            typicalFix: "Ensure the culture file exists beside the rig spec.",
          });
        } else if (knownPods.size > 0) {
          // Only backtick-wrapped `pod.member` tokens whose pod is a known pod —
          // avoids false positives on file paths (docs/x.md), versions, etc.
          const stale = new Set<string>();
          const re = /`([a-z0-9_-]+)\.([a-z0-9_-]+)`/gi;
          let match: RegExpExecArray | null;
          while ((match = re.exec(cultureText)) !== null) {
            const pod = match[1]!.toLowerCase();
            const seat = `${pod}.${match[2]!.toLowerCase()}`;
            if (knownPods.has(pod) && !knownSeats.has(seat)) stale.add(seat);
          }
          for (const seat of [...stale].sort()) {
            findings.push({
              kind: "stale_culture_seat_id",
              message: `culture references seat id '${seat}', which is not a current seat in rig.yaml (renamed or removed).`,
              typicalFix: "Update the culture block to the current seat id (a rename in rig.yaml must be mirrored in CULTURE.md).",
            });
          }
        }
      }

      const startup = spec["startup"];
      const startupFiles = startup && typeof startup === "object" && !Array.isArray(startup)
        ? (startup as Record<string, unknown>)["files"]
        : undefined;
      if (!Array.isArray(startupFiles) || startupFiles.length === 0) {
        findings.push({
          kind: "missing_startup_context",
          message: "No startup.files context is declared.",
          typicalFix: "Add startup.files for the environment context agents need at boot. See the openrig-architect skill's authoring workflow.",
        });
      }

      const result = { clean: findings.length === 0, findingCount: findings.length, findings };
      if (opts.json) {
        console.log(JSON.stringify(result));
        return;
      }
      if (result.clean) {
        console.log(`Spec audit clean: ${filePath}`);
        return;
      }
      console.log(`Spec audit: ${findings.length} advisory findings for ${filePath}`);
      for (const finding of findings) {
        console.log(`  - ${finding.message}\n    Typical fix: ${finding.typicalFix}`);
      }
      console.log("Advisory only: these findings do not block validation or launch.");
    });

  // rig spec validate <path>
  cmd
    .command("validate <path>")
    .description("Validate a rig spec (pure schema validation)")
    .option("--json", "JSON output")
    .action(async (filePath: string, opts: { json?: boolean }) => {
      const deps = getDeps();

      let yaml: string;
      try {
        yaml = deps.readFile(filePath);
      } catch {
        console.error(`Cannot read file: ${filePath}`);
        process.exitCode = 1;
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      const res = await client.postText<{ valid?: boolean; errors?: string[]; name?: string }>("/api/rigs/import/validate", yaml);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400 || !res.data.valid) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const data = res.data;
        if (data.errors && data.errors.length > 0) {
          console.error(`Rig spec invalid:\n${data.errors.map((e) => `  ${e}`).join("\n")}\nFix: update ${filePath} and re-validate.`);
        } else {
          console.error(`Validation failed (HTTP ${res.status}). Check rig spec YAML syntax.`);
        }
        process.exitCode = 1;
        return;
      }

      const data = res.data;
      if (data.valid) {
        const nameMatch = yaml.match(/^name:\s*(.+)$/m);
        const name = nameMatch?.[1]?.replace(/^["']|["']$/g, "").trim() ?? "unknown";
        console.log(`Rig spec valid: ${name}`);
      } else {
        if (data.errors && data.errors.length > 0) {
          console.error(`Rig spec invalid:\n${data.errors.map((e) => `  ${e}`).join("\n")}\nFix: update ${filePath} and re-validate.`);
        }
        process.exitCode = 1;
      }
    });

  // rig spec preflight <path>
  cmd
    .command("preflight <path>")
    .description("Run preflight diagnostics on a rig spec")
    .option("--rig-root <root>", "Root directory for pod-aware resolution")
    .option("--json", "JSON output")
    .action(async (filePath: string, opts: { rigRoot?: string; json?: boolean }) => {
      const deps = getDeps();

      let yaml: string;
      try {
        yaml = deps.readFile(filePath);
      } catch {
        console.error(`Cannot read file: ${filePath}`);
        process.exitCode = 1;
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      const rigRoot = opts.rigRoot
        ? nodePath.resolve(opts.rigRoot)
        : nodePath.dirname(nodePath.resolve(filePath));

      const extraHeaders: Record<string, string> = { "X-Rig-Root": rigRoot };

      const res = await client.postText<{ ready?: boolean; warnings?: string[]; errors?: string[] }>("/api/rigs/import/preflight", yaml, "text/yaml", extraHeaders);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400 || !res.data.ready) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        console.error(`Preflight failed (HTTP ${res.status}). Check your spec and rig-root path.`);
        process.exitCode = 1;
        return;
      }

      const data = res.data;
      if (data.errors && data.errors.length > 0) {
        console.log("Preflight errors:");
        for (const e of data.errors) console.log(`  - ${e}`);
      }
      if (data.warnings && data.warnings.length > 0) {
        console.log("Preflight warnings:");
        for (const w of data.warnings) console.log(`  - ${w}`);
      }
      if (data.ready) {
        console.log("Preflight ready");
      } else {
        console.log("Preflight not ready");
        process.exitCode = 1;
      }
    });

  return cmd;
}
