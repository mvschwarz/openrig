import { it, expect } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { recordedProcessEnded } from "../src/domain/reconciler.js";
import { parseWindowsProcesses } from "../src/domain/windows-process-table.js";
import { verifyPaneEmptyShell } from "../src/domain/native-process-lineage.js";

it("keeps unreadable live CIM PIDs unknown, while proving genuine absence and PID reuse",async()=>{
  const db=createFullTestDb();
  try{
    const rigs=new RigRepository(db),rig=rigs.createRig("native-absence"),node=rigs.addNode(rig.id,"writer",{runtime:"codex"});
    const session=new SessionRegistry(db).registerSession(node.id,"writer@native-absence");
    new SeatIdentityStore(db).upsert({nodeId:node.id,verdict:"verified",evidenceSource:"pane_process",reason:null,sessionName:session.sessionName,
      observedAt:"2030-01-01T00:00:00Z",evidence:{registeredPane:"%1",observedPanePid:100,observedPid:101,observedCommand:"codex",matchedLayer:1}});
    const check=(rows:ReturnType<typeof parseWindowsProcesses>)=>recordedProcessEnded(db,{nodeId:node.id,sessionName:session.sessionName,createdAt:"2026-01-01 00:00:00"},async()=>({rows,permissionHiddenPids:[]}));
    const partial=parseWindowsProcesses(JSON.stringify([{ProcessId:101,ParentProcessId:100,Name:"codex.exe",ExecutablePath:null,CommandLine:null,StartedAt:null}]));
    expect(await check(partial)).toBe(false);
    expect(await check([])).toBe(true);
    const reused=parseWindowsProcesses(JSON.stringify([{ProcessId:101,ParentProcessId:1,Name:"other.exe",ExecutablePath:"C:/other.exe",CommandLine:"other",StartedAt:"2030-01-02T00:00:00Z"}]));
    expect(await check(reused)).toBe(true);
    const unrelated=parseWindowsProcesses(JSON.stringify([{ProcessId:999,ParentProcessId:1,Name:"unknown.exe"}]));
    expect(await check(unrelated)).toBe(true);
  }finally{db.close();}
});

it("does not prove an empty Windows shell while an unreadable child remains",async()=>{
  const shell={platform:"win32" as const,pid:100,ppid:1,executableName:"powershell.exe",executablePath:"C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",command:'"C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" -NoProfile',startedAt:"2026-01-01T00:00:00Z"};
  const partial=parseWindowsProcesses(JSON.stringify([{ProcessId:101,ParentProcessId:100,Name:"unknown.exe"}]));
  const input={target:"%1",tmux:{getPanePid:async()=>100},consoleProcesses:async()=>[100]};
  expect(await verifyPaneEmptyShell({...input,listProcesses:async()=>[shell,...partial]})).toBe(false);
  expect(await verifyPaneEmptyShell({...input,listProcesses:async()=>[shell]})).toBe(true);
});
