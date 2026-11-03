import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { SftpClient } from "../src/lib/sftp-protocol.js";

const peer=`const u=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b},s=t=>Buffer.concat([u(Buffer.byteLength(t)),Buffer.from(t)]);const mode=process.argv[1];let input=Buffer.alloc(0),uid=mode==='same'?41:1,gid=mode==='same'?42:2,sets=0,stats=0;const send=(t,b)=>process.stdout.write(Buffer.concat([u(b.length+1),Buffer.from([t]),b])),status=(id,code)=>send(101,Buffer.concat([id,u(code),s('ownership response'),s('')]));process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4&&input.length>=4+input.readUInt32BE()){const n=input.readUInt32BE(),p=input.subarray(4,4+n);input=input.subarray(4+n);if(p[0]===1){send(2,u(3));continue}const id=p.subarray(1,5);if(p[0]===3){send(102,Buffer.concat([id,s('owned-stage-handle')]));continue}if(p[0]===6||p[0]===4){status(id,0);continue}if(p[0]===8){stats++;send(105,Buffer.concat([id,u(mode==='missing'?4:6),...(mode==='missing'?[]:[u(uid),u(gid)]),u(33152)]));continue}if(p[0]===10){sets++;const len=p.readUInt32BE(5),offset=9+len;const valid=p.subarray(9,offset).toString()==='owned-stage-handle'&&p.length===offset+12&&p.readUInt32BE(offset)===2&&p.readUInt32BE(offset+4)===41&&p.readUInt32BE(offset+8)===42;if(!valid){status(id,4);continue}if(mode==='deny'){status(id,3);continue}if(mode!=='noop'){uid=41;gid=42}status(id,0);continue}process.exit(9)}});process.stdin.on('end',()=>{const expectedSets=['change','deny','noop'].includes(mode)?1:0,expectedStats=mode==='deny'||mode==='missing'?1:mode==='incomplete'?0:2;process.exit(sets===expectedSets&&stats===expectedStats?0:7)});`;

it.each(["change","same","deny","noop","missing","incomplete"])("binds retained ownership to the stage handle (%s)",async mode=>{
  const child=spawn(process.execPath,["-e",peer,mode],{stdio:"pipe",windowsHide:true}),client=new SftpClient(child);
  try{
    await client.ready;
    const chunks=async function*(){yield Buffer.from("complete bytes");if(mode==="incomplete")throw Error("incomplete source");};
    const write=client.write("/owned/stage",chunks(),{uid:41,gid:42});
    if(mode==="deny")await expect(write).rejects.toMatchObject({code:3});
    else if(mode==="noop")await expect(write).rejects.toThrow("was not preserved");
    else if(mode==="missing")await expect(write).rejects.toThrow("cannot be qualified");
    else if(mode==="incomplete")await expect(write).rejects.toThrow("incomplete source");
    else await write;
  }finally{await client.close();}
  expect(child.exitCode).toBe(0);
});
