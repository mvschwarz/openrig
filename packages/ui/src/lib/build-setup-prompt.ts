export interface SetupPromptInput {
  name: string;
  summary?: string;
  sourcePath: string;
}

export function buildSetupPrompt(input: SetupPromptInput): string {
  const lines: string[] = [
    `Install and launch the "${input.name}" managed app using OpenRig.`,
    "",
  ];

  if (input.summary) {
    lines.push(`About: ${input.summary}`, "");
  }

  lines.push(
    `Source: ${input.sourcePath}`,
    "",
    "Steps:",
    `1. Run: rig up ${input.name}`,
    "2. Monitor: rig ps --nodes",
    "3. Check env: rig env status <rig-name>",
  );

  return lines.join("\n");
}
