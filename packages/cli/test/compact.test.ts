import {it,expect,vi,afterEach} from 'vitest';
import {compactCommand} from '../src/commands/compact.js';
import {DaemonClient, terminalAuthHeaders} from '../src/client.js';
import {Hono} from 'hono';
import {compactionRoutes} from '../../daemon/src/routes/compaction.js';
vi.mock('../src/daemon-lifecycle.js',()=>({getDaemonStatus:async()=>({state:'running',port:7433}),getDaemonUrl:()=> 'http://fixture'}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();process.exitCode=0;});
function fixture(){vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});const post=vi.fn(async()=>({status:200,data:{stage:'compact-sent'}}));const get=vi.fn(async()=>({status:200,data:{preparation:null}}));return{post,get,cmd:compactCommand({lifecycleDeps:{} as any,clientFactory:()=>({post,get}) as any})};}
it('manual request retains 180s HTTP ceiling and skip-map applies only to this invocation',async()=>{const f=fixture();await f.cmd.parseAsync(['node','rig','writer@demo','--skip-map']);expect(f.post).toHaveBeenCalledWith('/api/compaction/trigger',{session:'writer@demo',skipMap:true},expect.objectContaining({timeoutMs:180000}));});
it('ordinary manual request does not implicitly skip the map',async()=>{const f=fixture();await f.cmd.parseAsync(['node','rig','writer@demo']);expect(f.post.mock.calls[0]?.[1]).toEqual({session:'writer@demo'});});
it('state is read-only; cancel does not trigger',async()=>{const f=fixture();await f.cmd.parseAsync(['node','rig','writer@demo','--state']);expect(f.post).not.toHaveBeenCalled();expect(f.get).toHaveBeenCalledWith('/api/compaction/state?session=writer%40demo',{headers:terminalAuthHeaders()});const g=fixture();await g.cmd.parseAsync(['node','rig','writer@demo','--cancel']);expect(g.post.mock.calls[0]?.[0]).toBe('/api/compaction/cancel');});
it('contradictory explicit actions do not contact daemon',async()=>{const f=fixture();await f.cmd.parseAsync(['node','rig','writer@demo','--cancel','--skip-map']);expect(f.post).not.toHaveBeenCalled();expect(f.get).not.toHaveBeenCalled();expect(process.exitCode).toBe(1);});

// Exercise command -> actual client -> authenticated route without a listener.
it('state and cancel reach an authenticated daemon; a missing bearer stays rejected',async()=>{
 vi.stubEnv('OPENRIG_TERMINAL_BEARER_TOKEN','synthetic-compaction-test-token');
 const app=new Hono();const records:{path:string;status:number;authorized:boolean}[]=[];
 app.use('*',async(c,next)=>{
  c.set('compactionEnforcer' as never,{getManualCompactionState:()=>null,getPreparationState:()=>({status:'waiting'}),cancelPreparation:()=>({status:'stopped'})} as never);
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
