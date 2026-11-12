import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { SftpClient } from "../src/lib/sftp-protocol.js";

const peer=`let b=Buffer.alloc(0);process.stdin.on('data',c=>{b=Buffer.concat([b,c]);if(b.length>=9){if(b[4]!==1)process.exit(9);process.stdout.write(Buffer.from([0,0,0,5,2,0,0,0,3]));b=Buffer.alloc(0);}});process.stdin.on('end',()=>process.exit(0));`;
it.each([-1,4294967296,1.5,NaN])("rejects an unrepresentable final timestamp %s before OPEN or source consumption",async atime=>{
  const child=spawn(process.execPath,["-e",peer],{stdio:"pipe",windowsHide:true}),client=new SftpClient(child);let consumed=false;
  try{
    await client.ready;
    const chunks=async function*(){consumed=true;yield Buffer.from("not consumed");};
    await expect(client.write("/owned/stage",chunks(),{mode:0o640,atime,mtime:1700000000})).rejects.toThrow("SFTP v3 timestamps");
    expect(consumed).toBe(false);
  }finally{await client.close();}
  expect(child.exitCode).toBe(0);
});
