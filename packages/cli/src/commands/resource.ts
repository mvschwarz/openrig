import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { getOpenRigHome, readOpenRigEnv } from "../openrig-compat.js";
import { sessionRigOf } from "../session-name.js";

type Resource = { kind: string; url: string };
type ResourceLink = Resource & { ref: string; linkedBy: string };

const digest = (parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const kindPattern = /^[a-z][a-z0-9-]*$/;

function resourceOf(input: string, requestedKind?: string): Resource {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Use an HTTPS URL without embedded credentials.");
  }
  const pull = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
  const merge = /^(\/(?:[^/]+\/)+[^/]+)\/-\/merge_requests\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
  if (pull && (requestedKind === "pr" || (!requestedKind && url.hostname === "github.com"))) {
    return { kind: "pr", url: `${url.origin}/${pull[1]!.toLowerCase()}/${pull[2]!.toLowerCase()}/pull/${pull[3]}` };
  }
  if (merge && (!requestedKind || requestedKind === "mr")) {
    return { kind: "mr", url: `${url.origin}${merge[1]}/-/merge_requests/${merge[2]}` };
  }
  if (requestedKind === "pr" || requestedKind === "mr") {
    throw new Error(`URL does not match the ${requestedKind} path format.`);
  }
  const kind = requestedKind ?? "link";
  if (!kindPattern.test(kind)) throw new Error("Resource kind must use lowercase letters, digits, and hyphens.");
  return { kind, url: url.href };
}

function scope(): { dir: string; seat: string } {
  const seat = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
  const rig = seat && sessionRigOf(seat);
  if (!seat || !rig) throw new Error("Run rig resource from a managed seat.");
  return { dir: join(getOpenRigHome(), "resource-links", digest([rig])), seat };
}

function update(operation: "link" | "unlink", input: string, opts: { kind?: string; ref?: string }): void {
  const { dir, seat } = scope();
  const resource = resourceOf(input, opts.kind);
  const ref = opts.ref?.trim() ?? seat;
  if (!ref) throw new Error("Resource reference cannot be empty.");
  const path = join(dir, `${digest([resource.kind, resource.url, ref])}.json`);
  if (operation === "unlink") {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `${randomUUID()}.tmp`);
  const record: ResourceLink = { ...resource, ref, linkedBy: seat };
  writeFileSync(temporary, JSON.stringify(record), { flag: "wx" });
  try {
    linkSync(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function list(kind?: string) {
  const { dir } = scope();
  let names: string[];
  try { names = readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const grouped = new Map<string, Resource & { links: Array<Pick<ResourceLink, "ref" | "linkedBy">> }>();
  for (const name of names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
    let record: ResourceLink;
    try { record = JSON.parse(readFileSync(join(dir, name), "utf8")) as ResourceLink; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // Concurrent unlink.
      throw error;
    }
    if (kind && kind !== record.kind) continue;
    const key = JSON.stringify([record.kind, record.url]);
    const item = grouped.get(key) ?? { kind: record.kind, url: record.url, links: [] };
    item.links.push({ ref: record.ref, linkedBy: record.linkedBy });
    grouped.set(key, item);
  }
  return [...grouped.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.url.localeCompare(b.url));
}

export function resourceCommand(): Command {
  const command = new Command("resource").description("Manage this rig's shared resource links on this host");
  for (const operation of ["link", "unlink"] as const) {
    command.command(`${operation} <url>`)
      .description(operation === "link" ? "Add a resource association" : "Remove a resource association")
      .option("--kind <kind>", "Resource kind (pr, mr, or any custom kind)")
      .option("--ref <ref>", "Work reference (defaults to the current seat)")
      .action((url: string, opts: { kind?: string; ref?: string }) => update(operation, url, opts));
  }
  command.command("list").description("List the current rig's resource links")
    .option("--kind <kind>", "Filter by resource kind")
    .option("--json", "JSON output")
    .action((opts: { kind?: string; json?: boolean }) => {
      const entries = list(opts.kind);
      console.log(opts.json ? JSON.stringify(entries, null, 2) : entries.length
        ? entries.map(({ kind, url, links }) => `${kind}\t${url}\t${links.map(({ ref }) => ref).join(", ")}`).join("\n")
        : "No matching resource links for this rig.");
    });
  return command;
}
