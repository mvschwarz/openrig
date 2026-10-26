import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { parse } from "smol-toml";
import { CODEX_CORE_PLUGIN_KEY, type CodexConfigLayerRead } from "./codex-core-plugin-install.js";
import { findTomlTable } from "./toml-tables.js";

const { computeCodexHookTrust } = createRequire(import.meta.url)("../../assets/plugins/openrig-core/hooks/scripts/codex-hook-trust.cjs");
// Published openrig-core0.1.17: Codex0.164's native baseline and the complete shipped tree agree.
const LEGACY_CONTENT = process.platform === "win32" ? "sha256:f94b92a51872b7a5c0ba57d762a8cd68208a10f4e4ffed701220feafab626889" : "sha256:3317076e0df0d10402c17f26a17f26a21264980a6f0b551a1e21a3c0f785efca";
const LEGACY_DECLARATIONS: Record<string, string> = {
  session_start: "a746b5abb568d50725b08bf39660bbf08d15fa3d3a5961208862e7beaadba43d",
  user_prompt_submit_0: "f56dfb2a70982d6a7ae4a6c4ace58b943e16dcb08fe3bc87d3c8803477f4a5c1",
  user_prompt_submit_1: "c648714b3a02675ba4ea029b8e62dbcd77569afc317ad4f1bc3e8cbfbe7b34ee",
  stop: "bb444b151db38aff570d0ceadc2cc84b21afb021f00b15b326aef55a27d87d40",
  post_compact: "f4dd49518599c67ac23c80daef3537bb03b02e23a1e8c1da1210534766afefae",
  permission_request: "75c66b08f505a22f84def73ecf6d61e98dd1b24ed8ecdcc05306eba3013e64d4",
};
const legacyDeclarations = Object.fromEntries(Object.entries(LEGACY_DECLARATIONS).map(([event, hash]) => {
  const match = /^(user_prompt_submit)_([01])$/.exec(event);
  return [`${CODEX_CORE_PLUGIN_KEY}:hooks/codex.json:${match?.[1] ?? event}:${match?.[2] ?? 0}:0`, `sha256:${hash}`];
}));
const readFlags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0);

/** Codex rust-v0.164.0 plugin_fingerprint.rs. Strict comparison also includes entries Codex excludes as generated files. */
export function codexPluginContentHash(root: string, strict = false): string {
  if (!fs.lstatSync(root).isDirectory()) throw new Error("plugin root is not a directory");
  const hash = createHash("sha256").update("codex-plugin-bundle-v1");
  const length = (value: number) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); hash.update(bytes); };
  const visit = (file: string) => {
    const name = path.basename(file);
    if (file !== root && !strict && (name === "__pycache__" || name === ".venv" || name.endsWith(".pyc") || name.endsWith(".egg-info"))) return;
    const relative = Buffer.from(path.relative(root, file)); length(relative.length); hash.update(relative);
    const before = fs.lstatSync(file);
    if (before.isDirectory()) {
      hash.update("directory");
      for (const child of fs.readdirSync(file).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) visit(path.join(file, child));
    } else if (before.isFile()) {
      hash.update("file"); length(before.size);
      const fd = fs.openSync(file, readFlags);
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error("plugin file changed while fingerprinting");
        const buffer = Buffer.alloc(65536); let total = 0;
        while (total <= before.size) {
          const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size + 1 - total), null);
          if (!count) break;
          total += count; hash.update(buffer.subarray(0, count));
        }
        if (total !== before.size) throw new Error("plugin file changed while fingerprinting");
      } finally { fs.closeSync(fd); }
    } else throw new Error("unsupported plugin entry type");
  };
  visit(root);
  return `sha256:${hash.digest("hex")}`;
}

function readRecord(file: string): string | undefined {
  let fd: number;
  try { fd = fs.openSync(file, readFlags); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 65536 || (process.platform !== "win32" && (info.mode & 0o022) !== 0)
      || (process.getuid && info.uid !== process.getuid())) throw new Error("unreadable hook approval record");
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}

export function codexLegacyPluginTrustPath(configPath: string): string {
  const hash = createHash("sha256");
  for (const part of [configPath, CODEX_CORE_PLUGIN_KEY]) {
    const bytes = Buffer.from(part), size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(bytes.length)); hash.update(size); hash.update(bytes);
  }
  return path.join(path.dirname(configPath), ".hook-trust", hash.digest("hex"));
}

interface OwnedApproval { schema: 1; plugin: string; contentHash: string; declarations: Record<string, string> }
export const ownedCodexApprovalPath = (configPath: string) => path.join(path.dirname(configPath), ".openrig-core-hook-trust.json");

/** No native baseline is changed. Existing declarations must already be approved; only content approval may advance. */
export function planOwnedCodexContentApproval(input: {
  configPath: string; content: string; layers: CodexConfigLayerRead[]; shipped: string; installed: string; freshGrant?: boolean;
}): { hashes: Record<string, string>; approval: OwnedApproval } | undefined {
  try {
    if (codexPluginContentHash(input.shipped, true) !== codexPluginContentHash(input.installed, true)) return;
    const contentHash = codexPluginContentHash(input.installed);
    const declarations: Record<string, string> = {};
    const manifest = JSON.parse(fs.readFileSync(path.join(input.shipped, "hooks/codex.json"), "utf8"));
    for (const [event, groups] of Object.entries(manifest.hooks) as Array<[string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>]> ) {
      groups.forEach((group, groupIndex) => group.hooks.forEach((handler, handlerIndex) => {
        const { key, hash } = computeCodexHookTrust(event, { ...handler, matcher: group.matcher, timeoutSec: handler.timeout,
          keySource: `${CODEX_CORE_PLUGIN_KEY}:hooks/codex.json`, groupIndex, handlerIndex });
        declarations[key] = hash;
      }));
    }
    if (Object.keys(declarations).length !== 6) return;
    const docs = input.layers.map(layer => {
      if (layer.state === "unreadable") throw new Error("unknown config layer");
      return { ...layer, doc: layer.state === "read" ? parse(layer.content) : {} };
    });
    const doc = parse(input.content) as any;
    const otherChoice = (value: any, key: string, checkRoot = true): boolean => value !== null && typeof value === "object"
      && ((checkRoot && Object.hasOwn(value.hooks?.state ?? {}, key)) || Object.values(value).some(child => otherChoice(child, key)));
    const nestedPluginChoice = (value: any, nested = false): boolean => value !== null && typeof value === "object"
      && ((nested && (Object.hasOwn(value.plugins ?? {}, CODEX_CORE_PLUGIN_KEY) || Object.hasOwn(value.plugins ?? {}, "_default")))
        || Object.values(value).some(child => nestedPluginChoice(child, true)));
    if (docs.some(layer => nestedPluginChoice(layer.doc))) return;
    const states = doc.hooks?.state ?? {};
    for (const [key, hash] of Object.entries(declarations)) {
      const state = states[key];
      if (!state || (state.enabled !== undefined && state.enabled !== true) || state.trusted_hash !== hash
        || Object.keys(state).some(field => !["enabled", "trusted_hash", "trusted_content_hash"].includes(field))
        || findTomlTable(input.content.split("\n"), ["hooks", "state", key]) < 0
        || docs.some(layer => otherChoice(layer.doc, key, layer.path !== input.configPath))) return;
    }
    const approval: OwnedApproval = { schema: 1, plugin: CODEX_CORE_PLUGIN_KEY, contentHash, declarations };
    const hashes = Object.fromEntries(Object.keys(declarations).map(key => [key, contentHash]));
    if (input.freshGrant) return { hashes, approval };
    if (Object.keys(declarations).every(key => states[key].trusted_content_hash === contentHash)) return { hashes: {}, approval };
    const baseline = readRecord(codexLegacyPluginTrustPath(input.configPath));
    if (Object.keys(declarations).every(key => (states[key].trusted_content_hash ?? baseline) === contentHash)) return { hashes, approval };
    const saved = readRecord(ownedCodexApprovalPath(input.configPath));
    const previous: OwnedApproval = saved === undefined ? { schema: 1, plugin: CODEX_CORE_PLUGIN_KEY,
      contentHash: LEGACY_CONTENT, declarations: legacyDeclarations } : JSON.parse(saved);
    if (previous.schema !== 1 || previous.plugin !== CODEX_CORE_PLUGIN_KEY || !/^sha256:[a-f0-9]{64}$/.test(previous.contentHash)
      || Object.keys(previous.declarations).length !== 6) return;
    for (const [key, hash] of Object.entries(declarations)) {
      if (previous.declarations[key] !== hash || (states[key].trusted_content_hash ?? baseline) !== previous.contentHash) return;
    }
    return { hashes, approval };
  } catch { return undefined; } // Unknown ownership or config leaves native review in place.
}

export function recordOwnedCodexApproval(configPath: string, approval: OwnedApproval): void {
  const file = ownedCodexApprovalPath(configPath), content = `${JSON.stringify(approval, null, 2)}\n`;
  if (readRecord(file) === content) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
