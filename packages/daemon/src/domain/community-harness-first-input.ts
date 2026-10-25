import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDefaultOpenRigPath } from "../openrig-compat.js";

export interface FirstInputPassed {
  path: string;
  submission: "unconfirmed";
}

/** One immutable input per launch attempt; no text is put in the pane's launch command. */
export function writeFirstInput(session: string, text: string,
  root = getDefaultOpenRigPath(path.join("state", "first-input"))): FirstInputPassed {
  const dir = path.join(path.resolve(root), encodeURIComponent(session));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(dir) !== path.join(fs.realpathSync(root), path.basename(dir))) {
    throw new Error("first-input folder points outside this session's folder");
  }
  const file = path.join(dir, `${randomUUID()}.txt`);
  fs.writeFileSync(file, text, { mode: 0o600, flag: "wx" });
  return { path: file, submission: "unconfirmed" };
}
