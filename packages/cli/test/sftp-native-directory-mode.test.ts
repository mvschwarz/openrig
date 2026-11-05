import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runNativeSftpCopy } from "../src/lib/native-sftp-copy.js";

const peer=`const u=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b},s=t=>Buffer.concat([u(Buffer.byteLength(t)),Buffer.from(t)]);const existing=process.argv[1]==='existing';let created=existing,input=Buffer.alloc(0),mode=existing?488:448,atime=1200000000,mtime=1200000000,sets=0;const send=(t,b)=>process.stdout.write(Buffer.concat([u(b.length+1),Buffer.from([t]),b])),status=(id,c)=>send(101,Buffer.concat([id,u(c),s(c?'invalid directory traversal mode':''),s('')]));process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4&&input.length>=4+input.readUInt32BE()){const n=input.readUInt32BE(),p=input.subarray(4,4+n);input=input.subarray(4+n);if(p[0]===1){send(2,u(3));continue}const id=p.subarray(1,5);if(p[0]===7){if(!created){status(id,2);continue}send(105,Buffer.concat([id,u(15),Buffer.from('0000000000000000','hex'),u(1000),u(1000),u(16384|mode),u(atime),u(mtime)]));continue}if(p[0]===14){created=true;status(id,0);continue}if(p[0]===9){sets++;let offset=9+p.readUInt32BE(5),flags=p.readUInt32BE(offset);offset+=4;if(flags&4){mode=p.readUInt32BE(offset);offset+=4}if(mode!==(existing?488:448)){status(id,4);continue}if(flags&8){atime=p.readUInt32BE(offset);mtime=p.readUInt32BE(offset+4)}status(id,0);continue}process.exit(9)}});process.stdin.on('end',()=>process.exit(sets===1?0:7));`;

it.skipIf(process.platform!=="win32").each(["new","existing"])("Windows directory upload keeps a traversable known POSIX target mode (%s)",async variant=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"openrig-native-dir-mode-"));let child:ReturnType<typeof spawn>|undefined;
  try{
    const result=await runNativeSftpCopy({src:{kind:"local",path:root+path.sep},dst:{kind:"remote",path:"/owned/destination",host:{id:"owned",target:"owned",transport:"ssh"}},dryRun:false},()=>{
      const process=spawn(globalThis.process.execPath,["-e",peer,variant],{stdio:"pipe",windowsHide:true});child=process;return process;
    });
    expect(result.ok,result.stderr).toBe(true);expect(child?.exitCode).toBe(0);
  }finally{
    const canonical=await realpath(root),temporary=await realpath(os.tmpdir());
    if(path.dirname(canonical)!==temporary||!path.basename(canonical).startsWith("openrig-native-dir-mode-"))throw Error("Unexpected fixture root");
    await rm(canonical,{recursive:true,force:true});
  }
});
