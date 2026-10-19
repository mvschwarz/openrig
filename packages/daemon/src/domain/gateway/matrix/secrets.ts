import fs from "node:fs";
import path from "node:path";
import { getOpenRigHome } from "../../../openrig-compat.js";
import { parseEnvFile } from "../slack/secrets.js";

export function resolveAccessToken(opts: { envFile?: string | null; env?: NodeJS.ProcessEnv } = {}): string | null {
  const env = opts.env ?? process.env;
  if (env.OPENRIG_MATRIX_ACCESS_TOKEN || env.MATRIX_ACCESS_TOKEN) return env.OPENRIG_MATRIX_ACCESS_TOKEN || env.MATRIX_ACCESS_TOKEN!;
  if (!opts.envFile) return null;
  try { return parseEnvFile(fs.readFileSync(opts.envFile, "utf8")).MATRIX_ACCESS_TOKEN || null; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function saveAccessToken(token: string, home = getOpenRigHome(), envFile = path.join(home, "matrix-secrets.env")): string {
  // Tokens are opaque, single-line values; never interpolate them into shell code.
  if (!token.trim() || token !== token.trim() || /[\r\n]/.test(token)) throw new Error("Matrix access token must be a non-empty single-line value without surrounding whitespace");
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  let existing = "";
  try { existing = fs.readFileSync(envFile, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const kept = existing.split("\n").filter((line) => !/^\s*MATRIX_ACCESS_TOKEN\s*=/.test(line)).join("\n");
  const prefix = kept && !kept.endsWith("\n") ? `${kept}\n` : kept;
  fs.writeFileSync(`${envFile}.tmp`, `${prefix}MATRIX_ACCESS_TOKEN=${token}\n`, { mode: 0o600 });
  fs.chmodSync(`${envFile}.tmp`, 0o600);
  fs.renameSync(`${envFile}.tmp`, envFile);
  return envFile;
}
