import { expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { bindNativeSessionName } from "../src/domain/terminal/native-session-name.js";

it.each(["success","foreign-marker","write-refused"])("follows a mapped predecessor using verified physical names: %s",async mode=>{
  const identity={canonical:"seat:canonical",staging:"seat|staging",parking:"seat?parking",predecessorGeneration:"old",successorGeneration:"new"};
  const source=bindNativeSessionName(identity.staging),destination=bindNativeSessionName(identity.canonical);
  let attached=true;const writes:string[][]=[];
  const adapter=new TmuxAdapter(async()=>{throw Error("No shell");},undefined,async argv=>{
    const command=argv[1],target=argv[argv.indexOf("-t")+1];
    if(command==="has-session")return "";
    if(command==="show-options")return target===`=${source.physical}:` ? mode==="foreign-marker" ? "foreign" : source.marker! : destination.marker!;
    if(command==="list-clients")return attached ? argv.at(-1)!.replace("#{client_name}","client-1").replace("#{client_session}",source.physical) : "";
    if(command==="display-message")return attached ? "1" : "0";
    if(command==="if-shell"){
      writes.push(argv);expect(target).toBe(`=${source.physical}:`);
      expect(argv.at(-2)).toBe(`switch-client -c 'client-1' -t '=${destination.physical}'`);
      expect(argv[argv.indexOf("-t")+2]).toContain(`#{==:#{@openrig-logical-session-v1},${source.marker}}`);
      if(mode==="write-refused")return argv.at(-1)!.replace("display-message -p ","");
      attached=false;return "";
    }
    throw Error("Unexpected command "+command);
  },"psmux");
  vi.spyOn(adapter,"nativeRuntimeExchangeTerminal").mockReturnValue({ownsLifecycle:()=>true,
    observe:async()=>({canonical:{state:"present",generation:"new"},staging:{state:"present",generation:"old"},parking:{state:"absent"}}),rename:async()=>{throw Error("No rename in client following");}});
  const result=await adapter.followNativeRuntimeExchangeClients("node",identity);
  expect(result.ok).toBe(mode==="success");
  expect(writes).toHaveLength(mode==="foreign-marker"?0:1);
  expect(attached).toBe(mode!=="success");
});
