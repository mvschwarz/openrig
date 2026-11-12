import { link, lstat, mkdir, rename, rmdir, unlink } from 'node:fs/promises';
import { moveWindowsEntryNoReplace } from '@openrig/daemon/windows-owned-files';

/** Avoid ordinary overwriting file rename during a type exchange. Windows
 * uses one native no-replace move; POSIX directories reserve an empty slot. */
export async function moveLocalEntryNoReplace(source: string, destination: string): Promise<void> {
  if(process.platform==='win32'){moveWindowsEntryNoReplace(source,destination);return;}
  const entry=await lstat(source);
  if(!entry.isDirectory()){
    // link is exclusive and links the symlink entry itself on POSIX.
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
