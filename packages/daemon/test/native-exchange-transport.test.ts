import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { bindNativeSessionName } from "../src/domain/terminal/native-session-name.js";

function fixture(mapped=false,legacy=false) {
  const identity = {canonical:legacy?"openrig-native-v1-legacy":mapped?"seat:canonical":"canonical",staging:"staging",parking:mapped?"seat|parking":"parking",predecessorGeneration:"old",successorGeneration:"new"};
  const source=legacy?{logical:identity.canonical,physical:identity.canonical,marker:undefined}:bindNativeSessionName(identity.canonical),destination=bindNativeSessionName(identity.parking);
  const slots = new Map([[source.physical, `123|$0|456|node|old|${source.marker??""}|1|1|0|1`]]);
  const writes: string[][] = [];
  let lostReply = false, refuse = false;
  const adapter = new TmuxAdapter(async () => {throw Error("No shell transport");},undefined,async argv => {
    expect(argv.slice(0,3)).toEqual(["tmux","-L","owned-test"]);
    const command = argv[3], target = argv[argv.indexOf("-t") + 1]!.replace(/^=/, "").replace(/:$/, "");
    if (command === "has-session") {
      if (!slots.has(target)) throw Object.assign(Error("absent"),{code:1,stdout:"",stderr:""});
      return "";
    }
    if (command === "display-message") return slots.get(target)!;
    if (command === "if-shell") {
      writes.push(argv);
      const condition = argv[argv.indexOf("-t") + 2]!;
      for (const term of ["#{==:#{pid},123}","#{==:#{session_id},$0}","#{==:#{session_created},456}","#{==:#{OPENRIG_NODE_ID},node}","#{==:#{OPENRIG_OCCUPANT_GENERATION},old}",`#{==:#{@openrig-logical-session-v1},${slots.get(target)!.split("|")[5]}}`,"#{==:#{session_windows},1}","#{==:#{window_panes},1}","#{==:#{pane_dead},0}"]) expect(condition).toContain(term);
      if (refuse) return argv.at(-1)!.replace("display-message -p ","");
      if(argv.at(-2)!.startsWith("set-option")){
        expect(argv.at(-2)).toBe(`set-option -t '=${destination.physical}:' @openrig-logical-session-v1 '${destination.marker}'`);
        const row=slots.get(target)!.split("|");row[5]=destination.marker!;slots.set(target,row.join("|"));return "";
      }
      expect(argv.at(-2)).toBe(`rename-session -t '=${source.physical}' '${destination.physical}'`);
      slots.set(destination.physical,slots.get(source.physical)!);slots.delete(source.physical);
      if (lostReply) {lostReply=false;throw Error("reply lost");}
      return "";
    }
    throw Error("Unexpected terminal command " + command);
  },["-L","owned-test"],"psmux");
  Object.defineProperty(adapter,"isNativeWindows",{get:()=>true});
  return {backend:adapter.nativeRuntimeExchangeTerminal("node",identity),identity,source,destination,slots,writes,loseReply:()=>{lostReply=true;},refuse:()=>{refuse=true;}};
}

it("uses the selected server and command-boundary identity guard, then resumes a lost rename reply without replay",async()=>{
  const f=fixture(), intent=await f.backend.prepareRename!("canonical","parking","old");
  f.loseReply();await expect(f.backend.rename("canonical","parking","old",intent)).rejects.toThrow("reply lost");
  await f.backend.resumeRename!(intent);expect(f.writes).toHaveLength(1);
});
it("retains source when the command-boundary predicate refuses the write",async()=>{
  const f=fixture(),intent=await f.backend.prepareRename!("canonical","parking","old");f.refuse();
  await expect(f.backend.resumeRename!(intent)).rejects.toThrow("occupant changed");
  expect(f.slots.has("canonical")).toBe(true);expect(f.slots.has("parking")).toBe(false);
});
it("rejects recovery outside the backend's slots before terminal writes",async()=>{
  const f=fixture(),intent=await f.backend.prepareRename!("canonical","parking","old");
  await expect(f.backend.resumeRename!({...intent,to:"foreign"})).rejects.toThrow("outside its custody");expect(f.writes).toEqual([]);
});
it("repairs a mapped name marker through the production backend after an applied rename loses its reply",async()=>{
  const f=fixture(true),{canonical,parking}=f.identity,intent=await f.backend.prepareRename!(canonical,parking,"old");
  f.loseReply();await expect(f.backend.rename(canonical,parking,"old",intent)).rejects.toThrow("reply lost");
  await f.backend.resumeRename!(intent);
  expect(f.writes).toHaveLength(2);expect(f.slots.has(f.source.physical)).toBe(false);
  expect(f.slots.get(f.destination.physical)!.split("|")[5]).toBe(f.destination.marker);
  await f.backend.resumeRename!(intent);expect(f.writes).toHaveLength(2);
});
it("prepares and resumes an unmarked legacy physical source through the production adapter",async()=>{
  const f=fixture(true,true),{canonical,parking}=f.identity,intent=await f.backend.prepareRename!(canonical,parking,"old");
  expect(intent.sourceLegacy).toBe(true);
  f.loseReply();await expect(f.backend.rename(canonical,parking,"old",intent)).rejects.toThrow("reply lost");
  await f.backend.resumeRename!(intent);expect(f.writes).toHaveLength(2);
  expect(f.slots.has(canonical)).toBe(false);expect(f.slots.get(f.destination.physical)!.split("|")[5]).toBe(f.destination.marker);
});
