import nodePath from "node:path";
import type { ResolvedStartupFile } from "./runtime-adapter.js";

/** The guidance file that points a seat at its own skill catalog. Its own module, so a caller that needs only this
 *  record (a runtime switch's materials) doesn't load the instantiator and its preflight. */
export function seatSkillsPointerStartupFile(): ResolvedStartupFile {
  const assetsRoot = nodePath.resolve(import.meta.dirname, "../../assets");
  return {
    path: "openrig-seat-skills.md",
    absolutePath: nodePath.join(assetsRoot, "guidance/openrig-seat-skills.md"),
    ownerRoot: assetsRoot,
    deliveryHint: "guidance_merge",
    required: false,
    appliesOn: ["fresh_start", "restore"],
  };
}
