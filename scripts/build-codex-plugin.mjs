// The openrig plugin's Codex root, made at package time from the shared plugin folder: build-codex-plugin.mjs <shared> <out>.
//
// Codex 0.171 loads a plugin by its root plugin.json when that file's $schema is Agent Plugins, the manifest VS Code,
// Copilot CLI and Cursor read, and it runs no plugin hooks for that format. So Codex installs from this root instead. It has
// no root plugin.json: Codex's own manifest (.codex-plugin/plugin.json, which names hooks/codex.json and keeps the
// interface block), the skills, the Codex hooks and the bridge they run, all byte-equal to the shared folder's, and the
// shared folder's marketplace listing where Codex looks for one.
//
// ponytail: once Codex reads Agent Plugins 1.1 hooks, move the shared root to 1.1 with a portable root hooks.json and
// delete this Codex root (this script, its line in build-package.sh and its test), pointing the README's Codex commands back
// at the shared folder.
import { cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** [path in the shared folder, path in the Codex root] */
export const CODEX_ROOT_FILES = [
  ['.codex-plugin/plugin.json', '.codex-plugin/plugin.json'],
  ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'],
  ['skills', 'skills'],
  ['hooks/codex.json', 'hooks/codex.json'],
  ['hooks/scripts/claude-hook-bridge.cjs', 'hooks/scripts/claude-hook-bridge.cjs'],
  ['assets', 'assets'],
  ['LICENSE', 'LICENSE'],
];

export function buildCodexPlugin(shared, out) {
  for (const [from, to] of CODEX_ROOT_FILES) cpSync(join(shared, from), join(out, to), { recursive: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildCodexPlugin(process.argv[2], process.argv[3]);
