import {it,expect,vi,afterEach} from 'vitest';
import {compactCommand} from '../src/commands/compact.js';
import {DaemonClient, terminalAuthHeaders} from '../src/client.js';
import {Hono} from 'hono';
import {compactionRoutes} from '../../daemon/src/routes/compaction.js';
vi.mock('../src/daemon-lifecycle.js',()=>({getDaemonStatus:async()=>({state:'running',port:7433}),getDaemonUrl:()=> 'http://fixture'}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();process.exitCode=0;});
function fixture(){vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});const post=vi.fn(async()=>({status:200,data:{stage:'compact-sent'}}));const get=vi.fn(async()=>({status:200,data:{preparation:null}}));return{post,get,cmd:compactCommand({lifecycleDeps:{} as any,clientFactory:()=>({post,get}) as any})};}
it('manual request allows 240s HTTP ceiling and skip-map applies only to this invocation',async()=>{const f=fixture();await f.cmd.parseAsync(['node','rig','writer@demo','--skip-map']);expect(f.post).toHaveBeenCalledWith('/api/compaction/trigger',{session:'writer@demo',skipMap:true},expect.objectContaining({timeoutMs:240000}));});
it('ordinary manual request does not implicitly skip the map',async()=>{const f=fixture();await f.cmd.parseAsync(['node','rig','writer@demo']);expect(f.post.mock.calls[0]?.[1]).toEqual({session:'writer@demo'});});
it('state is read-only; cancel does not trigger',async()=>{const f=fixture();await f.cmd.parseAsync(['node','rig','writer@demo','--state']);expect(f.post).not.toHaveBeenCalled();expect(f.get).toHaveBeenCalledWith('/api/compaction/state?session=writer%40demo',{headers:terminalAuthHeaders()});const g=fixture();await g.cmd.parseAsync(['node','rig','writer@demo','--cancel']);expect(g.post.mock.calls[0]?.[0]).toBe('/api/compaction/cancel');});
it('contradictory explicit actions do not contact daemon',async()=>{const f=fixture();await f.cmd.parseAsync(['node','rig','writer@demo','--cancel','--skip-map']);expect(f.post).not.toHaveBeenCalled();expect(f.get).not.toHaveBeenCalled();expect(process.exitCode).toBe(1);});

// Exercise command -> actual client -> authenticated route without a listener.
it('state and cancel reach an authenticated daemon; a missing bearer stays rejected',async()=>{
 vi.stubEnv('OPENRIG_TERMINAL_BEARER_TOKEN','synthetic-compaction-test-token');
 const app=new Hono();const records:{path:string;status:number;authorized:boolean}[]=[];
 app.use('*',async(c,next)=>{
  c.set('compactionEnforcer' as never,{getManualCompactionState:()=>null,getPreparationState:()=>({status:'waiting'}),getStrandedCompaction:()=>null,getOwedRestore:()=>null,cancelPreparation:()=>({status:'stopped'})} as never);
  c.set('sessionTransport' as never,{resolveSessions:async()=>({ok:true,sessions:['writer@demo']})} as never);await next();
 });
 app.route('/api/compaction',compactionRoutes({bearerToken:'synthetic-compaction-test-token'}));
 const client=new DaemonClient('http://fixture',{fetchImpl:async(url,init)=>{
  const response=await app.request(new Request(String(url),init));
  records.push({path:new URL(String(url)).pathname,status:response.status,authorized:new Headers(init?.headers).has('Authorization')});return response;
 }});
 vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});
 const command=()=>compactCommand({lifecycleDeps:{} as any,clientFactory:()=>client});
 await command().parseAsync(['node','rig','writer@demo','--state']);const stateExit=process.exitCode??0;process.exitCode=0;
 await command().parseAsync(['node','rig','writer@demo','--cancel']);const cancelExit=process.exitCode??0;
 const missing=await client.get('/api/compaction/state?session=writer%40demo');
 expect(missing.status).toBe(401);expect(cancelExit).toBe(0);expect(records[1]).toMatchObject({status:200,authorized:true});
 expect(stateExit).toBe(0);expect(records[0]).toMatchObject({path:'/api/compaction/state',status:200,authorized:true});
});
it('a triggered compaction is reported as submitted, unconfirmed, never as having run',async()=>{const f=fixture();await f.cmd.parseAsync(['node','rig','writer@demo']);const out=(console.log as any).mock.calls.map((c:unknown[])=>String(c[0])).join('\n');expect(out).toContain('Manual compaction for writer@demo: submitted, unconfirmed (stage: compact-sent)');expect(out).not.toMatch(/compaction triggered|compacted/i);});

it('manual help binds180s preparation and preserves automatic25minutes',()=>{const f=fixture();let text='';f.cmd.configureOutput({writeOut:value=>{text+=value;}});f.cmd.outputHelp();expect(text).toContain('180 seconds');expect(text).toContain('25 minutes');expect(text).toContain('expiry disarms that attempt');});

// The cancellation receipt must retain uncertainty for both human and JSON callers.
for (const json of [false, true]) {
 it(`cancel displays the submitted-unconfirmed receipt without triggering (json=${json})`,async()=>{
  const f=fixture();
  f.post.mockResolvedValueOnce({status:200,data:{preparation:{status:'stopped',compact:'submitted_unconfirmed'},guidance:'Cancellation cannot undo a submitted /compact.'}} as any);
  await f.cmd.parseAsync(['node','rig','writer@demo','--cancel',...(json?['--json']:[])]);
  const output=JSON.parse(String((console.log as any).mock.calls[0][0]));
  expect(output.preparation).toMatchObject({status:'stopped',compact:'submitted_unconfirmed'});
  expect(output.guidance).toContain('cannot undo');
  expect(f.post).toHaveBeenCalledTimes(1);
  expect(f.post.mock.calls[0]?.[0]).toBe('/api/compaction/cancel');
 });
}
