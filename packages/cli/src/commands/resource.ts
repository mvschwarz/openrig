import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { getOpenRigHome, readOpenRigEnv } from "../openrig-compat.js";
import { sessionRigOf } from "../session-name.js";

export type Resource = { kind: string; id: string; url?: string; value?: string };
type ResourceLink = Resource & { ref: string; linkedBy: string; content?: string };
type ListedResource = Resource & { links: Array<Pick<ResourceLink, "ref" | "linkedBy" | "content">> };
export type NativeResourceEntry = Omit<Resource, "kind"> & { summary: string; details: object };
export type ResourceSource = { kind: string; list: (rig: string) => NativeResourceEntry[] };

const digest = (parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const kindPattern = /^[a-z][a-z0-9-]*$/;

function reviewResource(url: URL, kind?: string): { kind: "pr" | "mr"; url: string } | undefined {
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const pull = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
  if (pull && (kind === "pr" || (!kind && url.hostname === "github.com"))) {
    return { kind: "pr", url: `${url.origin}/${pull[1]!.toLowerCase()}/${pull[2]!.toLowerCase()}/pull/${pull[3]}` };
  }
  const merge = /^(\/(?:[^/]+\/)+[^/]+)\/-\/merge_requests\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
  if (merge && (!kind || kind === "mr")) {
    return { kind: "mr", url: `${url.origin}${merge[1]}/-/merge_requests/${merge[2]}` };
  }
  return undefined;
}

function resourceOf(input: string | undefined, requestedKind?: string, requestedId?: string): Resource {
  const id = requestedId?.trim();
  if (requestedId !== undefined && !id) throw new Error("Resource ID cannot be empty.");
  if (requestedKind !== undefined && !kindPattern.test(requestedKind)) {
    throw new Error("Resource kind must use lowercase letters, digits, and hyphens.");
  }
  if (input === undefined) {
    if (!requestedKind || !id) throw new Error("Without a value, supply both --kind and --id.");
    return { kind: requestedKind, id };
  }
  if (/^[a-z]:[\\/]/i.test(input) || !URL.canParse(input)) {
    if (!input.trim()) throw new Error("Resource value cannot be empty.");
    if (requestedKind === "pr" || requestedKind === "mr") throw new Error(`Expected a ${requestedKind} URL.`);
    return { kind: requestedKind ?? "value", id: id ?? input, value: input };
  }
  const url = new URL(input);
  if (url.username || url.password) throw new Error("Use a URI without embedded credentials.");
  const review = reviewResource(url, requestedKind);
  if (review) return { ...review, id: id ?? review.url };
  if (requestedKind === "pr" || requestedKind === "mr") {
    throw new Error(`URL does not match the ${requestedKind} path format.`);
  }
  return { kind: requestedKind ?? "link", id: id ?? url.href, url: url.href };
}

function scope(): { dir: string; seat: string; rig: string } {
  const seat = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
  const rig = seat && sessionRigOf(seat);
  if (!seat || !rig) throw new Error("Run rig resource from a managed seat.");
  return { dir: join(getOpenRigHome(), "resource-links", digest([rig])), seat, rig };
}

type LinkOptions = { kind?: string; id?: string; ref?: string; content?: string; contentFile?: string };

function update(operation: "link" | "unlink", input: string | undefined, opts: LinkOptions): void {
  const { dir, seat } = scope();
  const resource = resourceOf(input, opts.kind, opts.id);
  const ref = opts.ref?.trim() ?? seat;
  if (!ref) throw new Error("Resource reference cannot be empty.");
  const path = join(dir, `${digest([resource.kind, resource.id, ref])}.json`);
  if (operation === "unlink") {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `${randomUUID()}.tmp`);
  const content = opts.contentFile === undefined ? opts.content : readFileSync(opts.contentFile, "utf8");
  const record: ResourceLink = { ...resource, ref, linkedBy: seat, ...(content === undefined ? {} : { content }) };
  writeFileSync(temporary, JSON.stringify(record), { flag: "wx" });
  try {
    linkSync(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function listLinks(dir: string, kind?: string) {
  let names: string[];
  try { names = readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const grouped = new Map<string, ListedResource>();
  for (const name of names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
    let record: ResourceLink | (Omit<ResourceLink, "id" | "url"> & { url: string });
    try { record = JSON.parse(readFileSync(join(dir, name), "utf8")) as typeof record; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // Concurrent unlink.
      throw error;
    }
    if (kind && kind !== record.kind) continue;
    const id = "id" in record ? record.id : record.url;
    const key = JSON.stringify([record.kind, id]);
    const item: ListedResource = grouped.get(key) ?? { kind: record.kind, id, links: [] };
    item.url ??= record.url;
    if ("value" in record) item.value ??= record.value;
    item.links.push({ ref: record.ref, linkedBy: record.linkedBy, ...("content" in record ? { content: record.content } : {}) });
    grouped.set(key, item);
  }
  return [...grouped.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

export function resourceCommand(sources: readonly ResourceSource[] = []): Command {
  const command = new Command("resource").description("Manage this rig's shared resource links on this host");
  for (const operation of ["link", "unlink"] as const) {
    const subcommand = command.command(`${operation} [value]`)
      .alias(operation === "link" ? "add" : "remove")
      .description(operation === "link" ? "Add a resource association" : "Remove a resource association")
      .option("--kind <kind>", "Resource kind (pr, mr, or any custom kind)")
      .option("--id <id>", "Explicit resource ID (requires --kind when value is omitted)")
      .option("--ref <ref>", "Work reference (defaults to the current seat)");
    if (operation === "link") {
      subcommand.option("--content <text>", "Store text with this association")
        .option("--content-file <path>", "Store UTF-8 text from a local file");
    }
    subcommand.action((value: string | undefined, opts: LinkOptions) => {
      if (sources.some(({ kind }) => kind === opts.kind)) throw new Error(`Resource kind ${opts.kind} is read-only.`);
      if (opts.content !== undefined && opts.contentFile !== undefined) throw new Error("Choose --content or --content-file.");
      update(operation, value, opts);
    });
  }
  command.command("list").description("List the current rig's resource links")
    .option("--kind <kind>", "Filter by resource kind")
    .option("--json", "JSON output")
    .action((opts: { kind?: string; json?: boolean }) => {
      const { dir, rig } = scope();
      const links = listLinks(dir, opts.kind);
      const native = sources.filter(({ kind }) => !opts.kind || kind === opts.kind)
        .flatMap(({ kind, list }) => list(rig).map((entry) => ({ ...entry, kind })));
      const rows = [
        ...links.map(({ kind, id, url, links }) => `${kind}\t${id}${url && url !== id ? `\t${url}` : ""}\t${links.map(({ ref }) => ref).join(", ")}`),
        ...native.map(({ kind, id, summary }) => `${kind}\t${id}\t${summary}`),
      ];
      console.log(opts.json ? JSON.stringify([...links, ...native], null, 2)
        : rows.join("\n") || "No matching resources for this rig.");
    });
  return command;
}
