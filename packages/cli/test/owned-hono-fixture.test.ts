import { expect, it } from "vitest";
import { Hono } from "hono";
import { serveOwnedHonoFixture } from "./helpers/owned-hono-fixture.js";

it("returns a bound high-port Hono listener that retains request bodies, response status and headers",async()=>{
  const app=new Hono();
  app.post("/owned",async c=>{c.header("x-owned-fixture","yes");return c.json({body:await c.req.text()},201);});
  const server=await serveOwnedHonoFixture(app.fetch);
  try{
    const address=server.address() as {address:string;port:number};
    expect(server.listening).toBe(true);expect(address.address).toBe("127.0.0.1");expect(address.port).toBeGreaterThanOrEqual(49152);
    const response=await fetch(`http://127.0.0.1:${address.port}/owned`,{method:"POST",body:"owned payload"});
    expect(response.status).toBe(201);expect(response.headers.get("x-owned-fixture")).toBe("yes");expect(await response.json()).toEqual({body:"owned payload"});
    await expect(fetch("http://127.0.0.1:7433/healthz")).rejects.toThrow(/FETCH GUARD/);
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
