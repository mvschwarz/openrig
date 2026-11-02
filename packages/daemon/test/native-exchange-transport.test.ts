import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

function fixture() {
  const identity = {canonical:"canonical",staging:"staging",parking:"parking",predecessorGeneration:"old",successorGeneration:"new"};
  const slots = new Map([["canonical", "123|$0|456|node|old||1|1|0|1"]]);
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
      for (const term of ["#{==:#{pid},123}","#{==:#{session_id},$0}","#{==:#{session_created},456}","#{==:#{OPENRIG_NODE_ID},node}","#{==:#{OPENRIG_OCCUPANT_GENERATION},old}","#{==:#{@openrig-logical-session-v1},}","#{==:#{session_windows},1}","#{==:#{window_panes},1}","#{==:#{pane_dead},0}"]) expect(condition).toContain(term);
      if (refuse) return argv.at(-1)!.replace("display-message -p ","");
      expect(argv.at(-2)).toBe("rename-session -t '=canonical' 'parking'");
      slots.set("parking",slots.get("canonical")!);slots.delete("canonical");
      if (lostReply) {lostReply=false;throw Error("reply lost");}
      return "";
    }
    throw Error("Unexpected terminal command " + command);
  },["-L","owned-test"],"psmux");
  Object.defineProperty(adapter,"isNativeWindows",{get:()=>true});
  return {backend:adapter.nativeRuntimeExchangeTerminal("node",identity),slots,writes,loseReply:()=>{lostReply=true;},refuse:()=>{refuse=true;}};
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
