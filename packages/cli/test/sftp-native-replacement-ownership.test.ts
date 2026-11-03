import { expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runNativeSftpCopy } from "../src/lib/native-sftp-copy.js";

// This POSIX-shaped peer distinguishes stage ownership from the old destination
// and refuses publication unless the handle-bound identity was verified.
const peer=`const u=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b},s=t=>Buffer.concat([u(Buffer.byteLength(t)),Buffer.from(t)]);const directory=process.argv[1].startsWith('directory-'),mode=process.argv[1].replace(/^directory-/,'');let input=Buffer.alloc(0),uid=mode==='same'?41:1,gid=mode==='same'?42:2,sets=0,renames=0,removals=0,permissions=33184,atime=1200000000,mtime=1200000000;const send=(t,b)=>process.stdout.write(Buffer.concat([u(b.length+1),Buffer.from([t]),b])),status=(id,c)=>send(101,Buffer.concat([id,u(c),s(c?'permission denied':''),s('')])),attrs=(id,owner,group)=>send(105,Buffer.concat([id,u(15),Buffer.from('0000000000000013','hex'),u(owner),u(group),u(directory?16832:33184),u(1200000000),u(1200000000)]));process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4&&input.length>=4+input.readUInt32BE()){const n=input.readUInt32BE(),p=input.subarray(4,4+n);input=input.subarray(4+n);if(p[0]===1){send(2,Buffer.concat([u(3),s('posix-rename@openssh.com'),s('1')]));continue}const id=p.subarray(1,5);if(p[0]===7){attrs(id,41,42);continue}if(p[0]===11){send(102,Buffer.concat([id,s('directory')]));continue}if(p[0]===12){status(id,1);continue}if(p[0]===15){removals++;status(id,0);continue}if(p[0]===3){send(102,Buffer.concat([id,s('stage')]));continue}if(p[0]===6||p[0]===4||p[0]===9){status(id,0);continue}if(p[0]===8){send(105,Buffer.concat([id,u(15),Buffer.from('0000000000000013','hex'),u(uid),u(gid),u(permissions),u(atime),u(mtime)]));continue}if(p[0]===10){const offset=9+p.readUInt32BE(5),flags=p.readUInt32BE(offset);if(flags!==2){if(mode==='metadata-deny'){status(id,3);continue}if(mode!=='metadata-noop'){let at=offset+4;if(flags&4){permissions=32768|p.readUInt32BE(at);at+=4}if(flags&8){atime=p.readUInt32BE(at);mtime=p.readUInt32BE(at+4)}}status(id,0);continue}sets++;if(p.subarray(9,offset).toString()!=='stage'||p.readUInt32BE(offset)!==2||p.readUInt32BE(offset+4)!==41||p.readUInt32BE(offset+8)!==42){status(id,4);continue}if(mode==='deny'){status(id,3);continue}if(mode!=='noop'){uid=41;gid=42}status(id,0);continue}if(p[0]===200||p[0]===18){if(uid!==41||gid!==42||['deny','noop','metadata-noop','metadata-deny'].includes(mode))process.exit(8);renames++;status(id,0);continue}process.exit(9)}});process.stdin.on('end',()=>process.exit(sets===(mode==='same'?0:1)&&renames===((mode==='change'||mode==='same')?1:0)&&removals===(directory&&(mode==='change'||mode==='same')?1:0)?0:7));`;

it.skipIf(process.platform!=="win32").each(["change","same","deny","noop","metadata-noop","metadata-deny","directory-change","directory-deny"])("native Windows replacement retains the existing POSIX destination identity (%s)",async mode=>{
  const variant=mode.replace(/^directory-/,"");
  const root=await mkdtemp(path.join(os.tmpdir(),"openrig-copy-owner-")),source=path.join(root,"source");let child:ChildProcessWithoutNullStreams|undefined;
  try{
    await writeFile(source,"new upload payload with different bytes");
    const result=await runNativeSftpCopy({src:{kind:"local",path:source},dst:{kind:"remote",path:"/owned/destination",host:{id:"owned",target:"owned",transport:"ssh"}},dryRun:false},()=>{
      child=spawn(process.execPath,["-e",peer,mode],{stdio:"pipe",windowsHide:true});return child;
    });
    expect(result.ok,result.stderr).toBe(variant==="change"||variant==="same");
    if(variant==="deny"||variant==="metadata-deny")expect(result.stderr).toContain("permission denied");
    if(variant==="noop")expect(result.stderr).toContain("ownership was not preserved");
    if(variant==="metadata-noop")expect(result.stderr).toContain("mode or timestamps were not preserved");
    if(!result.ok)expect(result.hint).toContain("existing destination was not removed");
    expect(child?.exitCode).toBe(0);
  }finally{await rm(root,{recursive:true,force:true});}
});
