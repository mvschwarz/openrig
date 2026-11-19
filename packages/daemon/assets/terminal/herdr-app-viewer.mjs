// One owned viewer process per journal nonce; no shell parsing or replacement shell.
import { spawn } from "node:child_process";
const [nonce, encoded] = process.argv.slice(2);
const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
if (!nonce || !payload || (payload.argv !== null && (!Array.isArray(payload.argv) || payload.argv.some(v => typeof v !== "string" || v.includes("\0"))))) throw new Error("Invalid native viewer payload");
if (payload.argv?.length) {
  const [file,...args] = payload.argv;
  const child = spawn(file,args,{stdio:"inherit"});
  await new Promise(resolve => { child.once("error", error => { console.error(error.message); resolve(); }); child.once("exit", code => { console.log("\r\nThe seat session ended here (exit "+code+"). OpenRig will update this view."); resolve(); }); });
} else console.log(payload.message);
// Keep the cell alive until core ends this exact journal-owned terminal.
process.stdin.resume(); process.stdin.on("data", () => {}); setInterval(() => {}, 60_000);
