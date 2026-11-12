import { expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runNativeSftpCopy } from "../src/lib/native-sftp-copy.js";

// A normal receiving account owns the new stage. The previous destination has
// different numeric IDs, and this peer refuses any attempt to force a chown.
const peer = String.raw`
const u=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b},s=t=>Buffer.concat([u(Buffer.byteLength(t)),Buffer.from(t)]);
const directory=process.argv[1]==='directory',denied=process.argv[2]==='denied';
let input=Buffer.alloc(0),ownershipWrites=0,renames=0,removals=0,permissions=33184,atime=1200000000,mtime=1200000000,bytes=0;
const send=(t,b)=>process.stdout.write(Buffer.concat([u(b.length+1),Buffer.from([t]),b]));
const status=(id,c)=>send(101,Buffer.concat([id,u(c),s(c?'permission denied':''),s('')]));
const attrs=(id,old)=>send(105,Buffer.concat([id,u(15),Buffer.from((old?19:bytes).toString(16).padStart(16,'0'),'hex'),u(old?41:1),u(old?42:2),u(old?(directory?16832:33184):permissions),u(old?1200000000:atime),u(old?1200000000:mtime)]));
process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4&&input.length>=4+input.readUInt32BE()){
 const n=input.readUInt32BE(),p=input.subarray(4,4+n);input=input.subarray(4+n);
 if(p[0]===1){send(2,Buffer.concat([u(3),s('posix-rename@openssh.com'),s('1')]));continue}
 const id=p.subarray(1,5);
 if(p[0]===7){attrs(id,true);continue}
 if(p[0]===11){send(102,Buffer.concat([id,s('directory')]));continue}
 if(p[0]===12){status(id,1);continue}
 if(p[0]===15){removals++;status(id,0);continue}
 if(p[0]===3){send(102,Buffer.concat([id,s('stage')]));continue}
 if(p[0]===6){const at=9+p.readUInt32BE(5)+8;bytes+=p.readUInt32BE(at);status(id,0);continue}
 if(p[0]===4||p[0]===9){status(id,0);continue}
 if(p[0]===8){attrs(id,false);continue}
 if(p[0]===10){let at=9+p.readUInt32BE(5);const flags=p.readUInt32BE(at);at+=4;
  if(flags&2){ownershipWrites++;status(id,3);continue}
  if(denied){status(id,3);continue}
  if(flags&4){permissions=32768|p.readUInt32BE(at);at+=4}
  if(flags&8){atime=p.readUInt32BE(at);mtime=p.readUInt32BE(at+4)}status(id,0);continue}
 if(p[0]===200||p[0]===18){renames++;status(id,0);continue}
 process.exit(9);
}});
process.stdin.on('end',()=>process.exit(ownershipWrites===0&&renames===(denied?0:1)&&removals===(directory&&!denied?1:0)?0:7));
`;

it.skipIf(process.platform !== "win32").each([
  ["file", "accepted"], ["directory", "accepted"],
  ["file", "denied"], ["directory", "denied"],
])("replaces a POSIX %s without requiring chown (%s metadata)", async (type, metadata) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrig-sftp-replacement-")), source = path.join(root, "source");
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    await writeFile(source, "new upload payload with different bytes");
    const result = await runNativeSftpCopy({ src: { kind: "local", path: source }, dst: { kind: "remote", path: "/owned/destination", host: { id: "owned", target: "owned", transport: "ssh" } }, dryRun: false }, () => {
      child = spawn(process.execPath, ["-e", peer, type!, metadata!], { stdio: "pipe", windowsHide: true });return child;
    });
    expect(result.ok, result.stderr).toBe(metadata === "accepted");
    if (metadata === "denied") {
      expect(result.stderr).toContain("permission denied");
      expect(result.hint).toContain("existing destination was not removed");
    }
    expect(child?.exitCode).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
