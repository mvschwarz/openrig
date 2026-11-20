import { link, lstat, mkdir, readlink, rename, rmdir, symlink, unlink } from 'node:fs/promises';
import { moveWindowsEntryNoReplace } from '@openrig/daemon/windows-owned-files';

/** Avoid ordinary overwriting file rename during a type exchange. Windows
 * uses one native no-replace move; POSIX directories reserve an empty slot. */
export async function moveLocalEntryNoReplace(source: string, destination: string): Promise<void> {
  if(process.platform==='win32'){moveWindowsEntryNoReplace(source,destination);return;}
  const entry=await lstat(source);
  if(entry.isSymbolicLink()){
    // link() is implementation-defined for a symlink operand: BSD and macOS dereference it, which
    // hardlinks the target (or fails ENOENT when it is relative and dangles) instead of moving the
    // entry. symlink() is exclusive — it fails EEXIST if anything claimed the name — and always
    // creates the link entry itself, so the move is a no-replace handoff on every POSIX host.
    await symlink(await readlink(source),destination);await unlink(source);return;
  }
  if(!entry.isDirectory()){
    // link is exclusive.
    await link(source,destination);await unlink(source);return;
  }
  // Claim an empty slot exclusively. Directory rename cannot overwrite a file
  // or a directory which acquired contents, so another writer's bytes survive.
  await mkdir(destination,{mode:0o700});
  const claimed=await lstat(destination);
  try{await rename(source,destination);}
  catch(error){
    const current=await lstat(destination).catch(()=>undefined);
    if(current?.dev===claimed.dev&&current.ino===claimed.ino)await rmdir(destination).catch(()=>{/* a new child remains owned by its writer */});
    throw error;
  }
}
