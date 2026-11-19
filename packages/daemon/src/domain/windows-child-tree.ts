import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const taskkill = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
const running = (child: ChildProcess) => child.pid !== undefined && child.exitCode === null && child.signalCode === null;

/** Only a child still owned by Node is eligible; never address a reaped child's old PID. */
export async function killWindowsChildTree(child: ChildProcess): Promise<void> {
  if (!running(child)) return;
  await new Promise<void>((resolve) => {
    execFile(taskkill(), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, () => resolve());
  });
  // A failed tree query must still end the owned probe itself through Node's handle.
  if (running(child)) child.kill("SIGKILL");
}

/** Exit hooks cannot await; this is bounded and restricted to the same owned children. */
export function killWindowsChildTreeSync(child: ChildProcess): void {
  if (!running(child)) return;
  try {
    execFileSync(taskkill(), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000, stdio: "ignore" });
  } catch {
    if (running(child)) child.kill("SIGKILL");
  }
}
