import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Herdr config precedence: personal files win; only an absent config gets a private default. */
export function prepareHerdrLaunchConfig(env: NodeJS.ProcessEnv, socketPath: string, columns?: number): string {
  const source = path.resolve(env["HERDR_CONFIG_PATH"] ?? path.join(
    env["XDG_CONFIG_HOME"] ?? path.join(env["HOME"] ?? homedir(), ".config"), "herdr", "config.toml",
  ));
  // A personal config is authoritative, including an omitted sidebar setting and relative paths.
  try { readFileSync(source); return source; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const collapsed = !(Number.isSafeInteger(columns) && columns! >= 160);
  // Herdr shows its first-run tips over the view when `onboarding` is missing; the person's own
  // first Herdr launch outside OpenRig still gets them.
  const bytes = `onboarding = false\n\n[ui]\nsidebar_start_collapsed = ${collapsed}\n`;
  const key = createHash("sha256").update(source).update("\0").update(socketPath).update(String(collapsed)).digest("hex").slice(0, 20);
  const target = path.join(path.dirname(source), `.openrig-herdr-${key}.toml`);
  if (target === source) throw new Error("The private Herdr config must differ from the source config.");
  mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, target); }
  catch (error) { unlinkSync(temporary); throw error; }
  return target;
}
