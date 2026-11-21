// Test-only byte proxy around an actual owned OpenSSH subsystem.
const {spawn}=require('node:child_process');const fs=require('node:fs');
const spec=JSON.parse(process.argv[2]);
const server=spawn(spec.server,[],{stdio:'pipe',windowsHide:true});
server.stderr.pipe(process.stderr);
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const str=value=>Buffer.concat([u32(Buffer.byteLength(value)),Buffer.from(value)]);
let droppedId,armed=true;
function deny(id){const body=Buffer.concat([Buffer.from([101]),u32(id),u32(4),str('Injected rename refusal'),str('')]);process.stdout.write(Buffer.concat([u32(body.length),body]));}
function packets(stream,consume){let buffer=Buffer.alloc(0);stream.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const size=buffer.readUInt32BE(0);if(size>16*1024*1024)throw Error('oversized test packet');if(buffer.length<size+4)break;const packet=buffer.subarray(0,size+4);buffer=buffer.subarray(size+4);consume(packet);}});}
function text(packet,offset){const size=packet.readUInt32BE(offset);return [packet.subarray(offset+4,offset+4+size).toString('utf8'),offset+4+size];}
packets(process.stdin,packet=>{
  const type=packet[4],id=type===1?0:packet.readUInt32BE(5);let offset=9,rename=type===18;
  if(type===200){const [extension,next]=text(packet,offset);offset=next;rename=extension==='posix-rename@openssh.com';}
  let matched=false;
  if(rename&&armed){
    const [source,next]=text(packet,offset),[destination]=text(packet,next);
    const install=destination===spec.watched&&source.includes('/.openrig-copy-');
    if(spec.phase==='restore'&&install){deny(id);return;}
    matched=spec.phase==='backup'?source===spec.watched&&destination.includes('/.openrig-replaced-')
      :spec.phase==='restore'?destination===spec.watched&&source.includes('/.openrig-replaced-'):spec.phase==='install'&&install;
  }
  if(type===13&&armed&&spec.phase==='cleanup'){const [source]=text(packet,9);matched=source.includes('/.openrig-replaced-');}
    if(matched){
      armed=false;
      if(spec.action==='interfere')fs.writeFileSync(spec.nativeEntry,'foreign writer bytes',{flag:'wx'});
      if(spec.action!=='drop'){
        deny(id);return;
      }
      droppedId=id;
    }
  server.stdin.write(packet);
});
packets(server.stdout,packet=>{
  if(droppedId!==undefined&&packet[4]===101&&packet.readUInt32BE(5)===droppedId){
    if(packet.readUInt32BE(9)!==0)throw Error('injected lost reply was not a successful operation');
    server.stdin.end();return;
  }
  process.stdout.write(packet);
});
process.stdin.on('end',()=>server.stdin.end());
server.on('close',code=>process.exit(code??1));
server.on('error',error=>{console.error(error.message);process.exit(9);});
