import nodePath from "node:path";

export const MANAGED_BLOCK_START = (id: string) => `<!-- BEGIN RIGGED MANAGED BLOCK: ${id} -->`;
export const MANAGED_BLOCK_END = (id: string) => `<!-- END RIGGED MANAGED BLOCK: ${id} -->`;

export interface ManagedBlockMergeFsOps {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  mkdirp?(path: string): void;
}

export interface ManagedBlockCleanupFsOps extends ManagedBlockMergeFsOps {
  deleteFile(path: string): void;
}

export function mergeManagedBlock(
  fs: ManagedBlockMergeFsOps,
  targetPath: string,
  blockId: string,
  content: string,
): void {
  const begin = MANAGED_BLOCK_START(blockId);
  const end = MANAGED_BLOCK_END(blockId);
  const block = `${begin}\n${content}\n${end}`;

  if (!fs.exists(targetPath)) {
    fs.mkdirp?.(nodePath.dirname(targetPath));
    fs.writeFile(targetPath, block);
    return;
  }

  const existing = fs.readFile(targetPath);
  if (existing.includes(begin) && existing.includes(end)) {
    const regex = new RegExp(`${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}`, "g");
    fs.writeFile(targetPath, existing.replace(regex, block));
    return;
  }

  fs.writeFile(targetPath, `${existing}\n\n${block}`);
}

export function removeManagedBlocksFromFile(fs: ManagedBlockCleanupFsOps, targetPath: string): boolean {
  if (!fs.exists(targetPath)) {
    return false;
  }

  const original = fs.readFile(targetPath);
  const cleaned = stripManagedBlocks(original);
  if (cleaned.length === 0) {
    fs.deleteFile(targetPath);
    return true;
  }

  if (cleaned !== original.trim()) {
    fs.writeFile(targetPath, `${cleaned}\n`);
    return true;
  }

  return false;
}

export function stripManagedBlocks(content: string): string {
  return content
    .replace(/(?:\n|^)\s*<!-- BEGIN RIGGED MANAGED BLOCK: [\s\S]*?<!-- END RIGGED MANAGED BLOCK: [^>]+ -->\s*(?=\n|$)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
