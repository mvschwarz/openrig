// A synthetic community agent app for the agent-app runtime tests. It runs in the seat's pane as a Node process and
// reads one line at a time, skipping the envelope lines `rig send` adds: "busy" prints changing output for a few seconds, "ask" shows an approval prompt, "quit"
// exits back to the shell, and anything else is echoed back.
import { createInterface } from "node:readline";

const write = (text) => process.stdout.write(text);
write("synth-app 1.0 started\napp> ");
const rl = createInterface({ input: process.stdin });
let asking = false;
// `rig send` wraps a message in a short envelope (sender lines, a separator, a reply hint). Those lines aren't input.
const envelope = /^(From:|To:|Sent:|---|↩ Reply:)/;
rl.on("line", (line) => {
  const text = line.trim();
  if (!text || envelope.test(text)) return;
  // An answered prompt clears the screen, as apps redraw after an approval.
  if (asking) { asking = false; write(`\x1b[2J\x1b[Hanswered: ${text}\napp> `); return; }
  if (text === "quit") { write("bye\n"); process.exit(0); }
  if (text === "ask") { asking = true; write("Do you want to proceed? (y/n) "); return; }
  if (text === "busy") {
    let n = 0;
    const timer = setInterval(() => {
      write(`working step ${++n}\n`);
      if (n >= 12) { clearInterval(timer); write("done\napp> "); }
    }, 500);
    return;
  }
  write(`got: ${text}\napp> `);
});
