import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { SftpClient } from "../src/lib/sftp-protocol.js";

// Standard SFTP attributes retain numeric IDs for inspection, without applying them.
const peer=`const u=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b},s=t=>Buffer.concat([u(Buffer.byteLength(t)),Buffer.from(t)]);const uid=Number(process.argv[1]),gid=Number(process.argv[2]),deny=process.argv[3]==='deny';let input=Buffer.alloc(0);const send=(t,b)=>process.stdout.write(Buffer.concat([u(b.length+1),Buffer.from([t]),b]));process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4&&input.length>=4+input.readUInt32BE()){const n=input.readUInt32BE(),p=input.subarray(4,4+n);input=input.subarray(4+n);if(p[0]===1){send(2,u(3));continue}const id=p.subarray(1,5);if(p[0]===7||p[0]===17){send(105,Buffer.concat([id,u(15),Buffer.from('000000000000002a','hex'),u(uid),u(gid),u(33184),u(1700000000),u(1700000001)]));continue}if(p[0]===9){const offset=9+p.readUInt32BE(5);const valid=p.length===offset+12&&p.readUInt32BE(offset)===2&&p.readUInt32BE(offset+4)===uid&&p.readUInt32BE(offset+8)===gid;send(101,Buffer.concat([id,u(valid?(deny?3:0):4),s(valid?'permission denied':'invalid ownership packet'),s('')]));continue}process.exit(9)}});process.stdin.on('end',()=>process.exit(0));`;
function client(uid=1000,gid=1001,deny=false){return new SftpClient(spawn(process.execPath,["-e",peer,String(uid),String(gid),deny?"deny":"allow"],{stdio:"pipe",windowsHide:true}));}

it.each([[0,0],[1000,1001],[4294967295,4000000000]])("decodes uid/gid %i/%i alongside size, mode and timestamps",async(uid,gid)=>{
  const c=client(uid,gid);
  try{
    await c.ready;
    expect(await c.lstat("/owned")).toEqual({size:42,uid,gid,mode:33184,atime:1700000000,mtime:1700000001});
    expect(await c.stat("/owned")).toMatchObject({uid,gid});
  }finally{await c.close();}
});
