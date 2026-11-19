import {it,expect} from "vitest";
import {execArgvCommand} from "../src/adapters/tmux-exec.js";

it("passes private process environment separately from argv without mutating the parent",async()=>{
 const key="OPENRIG_TEST_PRIVATE_PROCESS_VALUE",before=process.env[key],value="synthetic ' 中文\nprivate";
 const result=await execArgvCommand([process.execPath,"-e",`process.stdout.write(JSON.stringify({value:process.env.${key},argv:process.argv.slice(1)}))`],{env:{[key]:value}});
 expect(JSON.parse(result)).toEqual({value,argv:[]});expect(process.env[key]).toBe(before);
 expect(execArgvCommand.supportsEnvironment).toBe(true);
 await expect(execArgvCommand([process.execPath,"-e",""],{env:{[key]:"bad\0value"}})).rejects.toThrow("Invalid process environment");
});
