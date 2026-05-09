function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(token: string): string | null {
  try {
    const normalized = token.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function librarySkillToken(skillId: string): string {
  return encodeBase64Url(skillId);
}

export function librarySkillFileToken(filePath: string): string {
  return encodeBase64Url(filePath);
}

export function librarySkillIdFromToken(token: string): string | null {
  return decodeBase64Url(token);
}

export function librarySkillFilePathFromToken(token: string): string | null {
  return decodeBase64Url(token);
}

export function librarySkillHref(skillId: string): string {
  return `/specs/skills/${librarySkillToken(skillId)}`;
}

export function librarySkillFileHref(skillId: string, filePath: string): string {
  return `${librarySkillHref(skillId)}/file/${librarySkillFileToken(filePath)}`;
}

export function librarySkillSelectionFromPath(pathname: string): {
  skillId: string;
  filePath: string | null;
} | null {
  const match = pathname.match(/^\/specs\/skills\/([^/]+)(?:\/file\/([^/]+))?$/);
  if (!match) return null;
  const skillToken = match[1];
  if (!skillToken) return null;
  const skillId = librarySkillIdFromToken(skillToken);
  if (!skillId) return null;
  const filePath = match[2] ? librarySkillFilePathFromToken(match[2]) : null;
  return { skillId, filePath };
}
