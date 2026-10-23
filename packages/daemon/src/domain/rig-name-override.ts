import { isMap, parse, parseDocument } from "yaml";

/**
 * `rig up <spec> --name <rig>`: the spec text with its `name:` set to the chosen rig name, before anything
 * parses it, so validation, the running-name guard, the per-name import lock, the Compose project name,
 * `rigs.name` and seat names all see one name. The file on disk is not changed; comments are kept.
 * Text that does not parse as a mapping is returned as is, for the existing parse error to report.
 */
export function withRigName(rawYaml: string, rigName: string | undefined): string {
  if (rigName === undefined) return rawYaml;
  const doc = parseDocument(rawYaml);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return rawYaml;
  doc.set("name", rigName);
  return doc.toString();
}

/**
 * A spec that fixes `services.project_name` gives every rig launched from it one Compose project, and
 * `rig down` or a failed service boot of one rig runs `compose down` on that project, stopping the other
 * rigs' services. So a chosen name is refused for such a spec. Returns the refusal, or null.
 */
export function rigNameComposeProjectConflict(rawYaml: string, rigName: string | undefined): string | null {
  if (rigName === undefined) return null;
  let spec: unknown;
  try { spec = parse(rawYaml); } catch { return null; }
  const services = (spec as { services?: unknown } | null)?.services;
  const projectName = services && typeof services === "object" ? (services as Record<string, unknown>)["project_name"] : undefined;
  if (typeof projectName !== "string") return null;
  return `--name ${rigName}: this spec sets services.project_name "${projectName}", so every rig launched from it would share that Compose project, and rig down or a failed service boot of one would stop the others' services. Nothing was created. Launch it without --name, or launch a copy of the spec with its own project_name.`;
}
