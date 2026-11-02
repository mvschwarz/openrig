import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeRuntimeSwitchJournal, executeNativeRuntimeExchange, type NativeExchangeTerminal } from "../src/domain/native-runtime-switch-journal.js";
import type { NativeExchangeSlot } from "../src/domain/native-runtime-switch-exchange.js";

const identity={canonical:"seat@rig",staging:"openrig-switch-owned",parking:"openrig-parking-owned",predecessorGeneration:"old",successorGeneration:"new"};
function seed(db:Database.Database){
  db.exec(`CREATE TABLE seat_runtime_switches(id TEXT PRIMARY KEY,node_id TEXT,canonical_session TEXT,staging_session TEXT,
    predecessor_generation TEXT,successor_generation TEXT,phase TEXT,committed_at TEXT,plan_json TEXT)`);
  db.prepare("INSERT INTO seat_runtime_switches VALUES(?,?,?,?,?,?,?,?,?)").run("switch","node",identity.canonical,identity.staging,"old","new","confirmed",null,JSON.stringify({warnings:["retain existing plan"]}));
}
function terminal(db:Database.Database,failAfterRename:number|null=null){
  const slots=new Map([[identity.canonical,"old"],[identity.staging,"new"]]);let calls=0,leased=true;
  const observeSlot=(name:string):NativeExchangeSlot=>slots.has(name)?{state:"present",generation:slots.get(name)!}:{state:"absent"};
  const adapter:NativeExchangeTerminal={ownsLifecycle:()=>leased,observe:async()=>({canonical:observeSlot(identity.canonical),staging:observeSlot(identity.staging),parking:observeSlot(identity.parking)}),
    rename:async(from,to,expected)=>{
      expect(new NativeRuntimeSwitchJournal(db,"switch","node").read()).not.toBeNull();
      expect(slots.get(from)).toBe(expected);expect(slots.has(to)).toBe(false);
      slots.set(to,slots.get(from)!);slots.delete(from);calls++;
      if(calls===failAfterRename)throw Error("client result unknown after server applied rename");
    }};
  return {adapter,slots,calls:()=>calls,loseLease:()=>{leased=false;}};
}

describe("durable native runtime exchange",()=>{
  it.each([1,2,3])("reobserves after an unknown result at rename %i, without replaying it",async failure=>{
    const db=new Database(":memory:");seed(db);
    try{
      const state=terminal(db,failure),journal=new NativeRuntimeSwitchJournal(db,"switch","node");
      expect(await executeNativeRuntimeExchange(journal,state.adapter,identity,"forward")).toMatchObject({ok:false,pending:true});
      expect(state.calls()).toBe(failure);
      const recovered=new NativeRuntimeSwitchJournal(db,"switch","node").read()!;
      expect(await executeNativeRuntimeExchange(new NativeRuntimeSwitchJournal(db,"switch","node"),state.adapter,recovered.identity,recovered.direction)).toEqual({ok:true});
      expect(state.calls()).toBe(3);expect(state.slots.get(identity.canonical)).toBe("new");
      expect(await executeNativeRuntimeExchange(journal,state.adapter,identity,"rollback")).toEqual({ok:true});
      expect(state.slots).toEqual(new Map([[identity.canonical,"old"],[identity.staging,"new"]]));
    }finally{db.close();}
  });
  it("survives closing and reopening its SQLite connection without overwriting the original plan",()=>{
    const root=mkdtempSync(path.join(os.tmpdir(),"native-exchange-journal-")),file=path.join(root,"owned.db");let db=new Database(file);
    try{
      seed(db);new NativeRuntimeSwitchJournal(db,"switch","node").prepare(identity,"forward");db.close();db=new Database(file);
      expect(new NativeRuntimeSwitchJournal(db,"switch","node").read()).toEqual({schema:"openrig.native-runtime-exchange/v1",identity,direction:"forward"});
      const plan=JSON.parse((db.prepare("SELECT plan_json FROM seat_runtime_switches").get() as {plan_json:string}).plan_json);
      expect(plan.warnings).toEqual(["retain existing plan"]);
    }finally{db.close();rmSync(root,{recursive:true,force:true});}
  });
  it("does not write or rename without the lifecycle lease",async()=>{
    const db=new Database(":memory:");seed(db);
    try{
      const state=terminal(db),journal=new NativeRuntimeSwitchJournal(db,"switch","node");state.loseLease();
      expect(await executeNativeRuntimeExchange(journal,state.adapter,identity,"forward")).toMatchObject({ok:false,pending:true});
      expect(state.calls()).toBe(0);expect(journal.read()).toBeNull();
    }finally{db.close();}
  });
  it("refuses foreign custody and rollback after commit",()=>{
    const db=new Database(":memory:");seed(db);
    try{
      const journal=new NativeRuntimeSwitchJournal(db,"switch","node");journal.prepare(identity,"forward");
      expect(()=>new NativeRuntimeSwitchJournal(db,"switch","foreign").prepare(identity,"forward")).toThrow("custody");
      expect(()=>journal.prepare({...identity,parking:"foreign-parking"},"forward")).toThrow("another identity");
      db.prepare("UPDATE seat_runtime_switches SET phase='committed',committed_at='owned-stamp'").run();
      expect(()=>journal.prepare(identity,"rollback")).toThrow("commit state");
      expect(journal.read()?.direction).toBe("forward");
    }finally{db.close();}
  });
  it("retains custody but writes no rename if the lease is lost during observation",async()=>{
    const db=new Database(":memory:");seed(db);
    try{
      const state=terminal(db),journal=new NativeRuntimeSwitchJournal(db,"switch","node");
      const observe=state.adapter.observe;state.adapter.observe=async()=>{const slots=await observe();state.loseLease();return slots;};
      expect(await executeNativeRuntimeExchange(journal,state.adapter,identity,"forward")).toMatchObject({ok:false,pending:true});
      expect(state.calls()).toBe(0);expect(journal.read()?.direction).toBe("forward");
    }finally{db.close();}
  });
  it("does not persist malformed identities",()=>{
    const db=new Database(":memory:");seed(db);
    try{
      const journal=new NativeRuntimeSwitchJournal(db,"switch","node");
      expect(()=>journal.prepare({...identity,parking:"invalid|name"},"forward")).toThrow("Invalid");
      expect(journal.read()).toBeNull();
    }finally{db.close();}
  });
});
