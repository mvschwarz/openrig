import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";

/** Herdr 0.9.3 config precedence; a sibling copy preserves config-relative paths. */
export function prepareHerdrLaunchConfig(env: NodeJS.ProcessEnv, socketPath: string): string {
  const source = path.resolve(env["HERDR_CONFIG_PATH"] ?? path.join(
    env["XDG_CONFIG_HOME"] ?? path.join(env["HOME"] ?? homedir(), ".config"), "herdr", "config.toml",
  ));
  let text = "";
  try { text = readFileSync(source, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Preserve integer/float distinctions and large integers when serializing TOML.
  const config = parse(text, { integersAsBigInt: true });
  const ui = config["ui"];
  if (ui !== undefined && (!ui || typeof ui !== "object" || Array.isArray(ui) || ui instanceof Date)) {
    throw new Error(`Herdr's ui setting must be a table: ${source}`);
  }
  config["ui"] = { ...ui, sidebar_start_collapsed: true };
  const bytes = stringify(config, { numbersAsFloat: true });
  const key = createHash("sha256").update(source).update("\0").update(socketPath).digest("hex").slice(0, 20);
  const target = path.join(path.dirname(source), `.openrig-herdr-${key}.toml`);
  if (target === source) throw new Error("The private Herdr config must differ from the source config.");
  mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, target); }
  catch (error) { unlinkSync(temporary); throw error; }
  return target;
}
