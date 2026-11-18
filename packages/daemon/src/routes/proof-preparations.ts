import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

type Preparation = { session: string | null; scope: string | undefined; project: string | null; root: string; missions: string };

/** Short-lived in-memory capabilities, invalidated on daemon restart. */
export class ProofPreparations {
  private readonly entries = new Map<string, Preparation>();

  issue(value: Preparation): string {
    const receipt = randomBytes(32).toString("base64url");
    this.entries.set(receipt, { ...value, root: fs.realpathSync(value.root), missions: fs.realpathSync(value.missions) });
    if (this.entries.size > 1024) this.entries.delete(this.entries.keys().next().value!);
    return receipt;
  }

  verify(receipt: unknown, value: Preparation): { root: string; missions: string } | null {
    const saved = typeof receipt === "string" ? this.entries.get(receipt) : undefined;
    if (!saved || !path.isAbsolute(value.root) || !path.isAbsolute(value.missions)) return null;
    try {
      const root = fs.realpathSync(value.root), missions = fs.realpathSync(value.missions);
      const relative = path.relative(root, missions);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
          || !fs.statSync(root).isDirectory() || !fs.statSync(missions).isDirectory()
          || saved.session !== value.session || saved.scope !== value.scope || saved.project !== value.project
          || saved.root !== root || saved.missions !== missions) return null;
      return { root, missions };
    } catch { return null; }
  }
}
