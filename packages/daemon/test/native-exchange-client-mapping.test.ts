import { expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { bindNativeSessionName } from "../src/domain/terminal/native-session-name.js";

it.each(["success","dead-predecessor","foreign-marker","write-refused","source-replaced-before","successor-replaced-after","lease-lost-before"])("follows a mapped predecessor using verified physical names: %s",async mode=>{
  const identity={canonical:"seat:canonical",staging:"seat|staging",parking:"seat?parking",predecessorGeneration:"old",successorGeneration:"new"};
  const source=bindNativeSessionName(identity.staging),destination=bindNativeSessionName(identity.canonical);
  let attached=true,replaced=false,listed=false,lease=true;const writes:string[][]=[];
  const adapter=new TmuxAdapter(async()=>{throw Error("No shell");},undefined,async argv=>{
    const command=argv[1],target=argv[argv.indexOf("-t")+1];
    if(command==="has-session")return "";
    if(command==="show-options")return target===`=${source.physical}:` ? mode==="foreign-marker" ? "foreign" : source.marker! : destination.marker!;
    if(command==="list-clients"){
      listed=true;
      if(mode==="source-replaced-before")replaced=true;
      return attached ? argv.at(-1)!.replace("#{client_name}","client-1").replace("#{client_session}",source.physical) : "";
    }
    if(command==="display-message"){
      if(argv.at(-1)==="#{session_attached}")return attached ? "1" : "0";
      const isSource=target===`=${source.physical}:`,binding=isSource?source:destination;
      if(!isSource&&listed&&mode==="lease-lost-before")lease=false;
      const changed=(isSource&&mode==="source-replaced-before"&&replaced)||(!isSource&&mode==="successor-replaced-after"&&!attached);
      return `${changed?"999":isSource?"123":"456"}|$0|789|node|${isSource?"old":"new"}|${binding.marker}|1|1|${isSource&&mode==="dead-predecessor"?"1":"0"}|${binding.physical}`;
    }
    if(command==="if-shell"){
      writes.push(argv);expect(target).toBe(`=${source.physical}:`);
      expect(argv.at(-2)).toBe(`switch-client -c 'client-1' -t '=${destination.physical}'`);
      expect(argv[argv.indexOf("-t")+2]).toContain(`#{==:#{@openrig-logical-session-v1},${source.marker}}`);
      for(const term of ["#{==:#{pid},123}","#{==:#{session_id},$0}","#{==:#{session_created},789}"])expect(argv[argv.indexOf("-t")+2]).toContain(term);
      if(mode==="write-refused")return argv.at(-1)!.replace("display-message -p ","");
      attached=false;return "";
    }
    throw Error("Unexpected command "+command);
  },"psmux");
  vi.spyOn(adapter,"nativeRuntimeExchangeTerminal").mockReturnValue({ownsLifecycle:()=>lease,
    observe:async()=>({canonical:{state:"present",generation:"new"},staging:{state:"present",generation:"old"},parking:{state:"absent"}}),rename:async()=>{throw Error("No rename in client following");}});
  const result=await adapter.followNativeRuntimeExchangeClients("node",identity);
  expect(result.ok).toBe(mode==="success"||mode==="dead-predecessor");
  expect(writes).toHaveLength(["foreign-marker","source-replaced-before","lease-lost-before"].includes(mode)?0:1);
  expect(attached).toBe(["foreign-marker","source-replaced-before","write-refused","lease-lost-before"].includes(mode));
});
