import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nativePsmuxScaffold } from "./helpers/native-psmux-scaffold.js";
import { powershellQuote } from "../src/adapters/windows-launch.js";

it.skipIf(process.platform !== "win32" || !process.env.OPENRIG_TEST_PSMUX)("starts and cleans a real isolated native psmux scaffold", async () => {
  const first = nativePsmuxScaffold(process.env.OPENRIG_TEST_PSMUX!);
  const second = nativePsmuxScaffold(process.env.OPENRIG_TEST_PSMUX!);
  try {
    expect(first.namespace).not.toBe(second.namespace);
    expect(first.registry).not.toBe(second.registry);
    expect(Object.isFrozen(first.env)).toBe(true);
    await expect(first.run(["-L", "foreign", "list-sessions"])).rejects.toThrow(/endpoint overrides/);
    await expect(first.run(["list-sessions", "-Lforeign"])).rejects.toThrow(/endpoint overrides/);
    await first.run(["new-session", "-d", "-s", "first", "-c", first.root]);
    await second.run(["new-session", "-d", "-s", "second", "-c", second.root]);
    expect(await first.run(["show-options", "-g", "-v", "default-shell"])).toContain("-NoProfile");
    expect((await first.run(["list-sessions", "-F", "#{session_name}"])).trim()).toBe("first");
    expect((await second.run(["list-sessions", "-F", "#{session_name}"])).trim()).toBe("second");
    const firstPid = Number((await first.run(["display-message", "-p", "#{pid}"])).trim());
    const secondPid = Number((await second.run(["display-message", "-p", "#{pid}"])).trim());
    expect(firstPid).toBeGreaterThan(1);
    expect(secondPid).toBeGreaterThan(1);
    expect(firstPid).not.toBe(secondPid);
    const output = path.join(first.root, "receipt.json");
    const command = `[IO.File]::WriteAllText(${powershellQuote(output)},(ConvertTo-Json @{home=$env:HOME;profile=$env:USERPROFILE;registry=$env:PSMUX_DATA_DIR}))`;
    await first.run(["send-keys", "-t", "=first:", "-l", command]);
    await first.run(["send-keys", "-t", "=first:", "Enter"]);
    await expect.poll(() => fs.existsSync(output), { timeout: 7000 }).toBe(true);
    expect(JSON.parse(fs.readFileSync(output, "utf8").replace(/^\uFEFF/, ""))).toEqual({ home: first.root, profile: first.root, registry: first.registry });
    await first.cleanup();
    expect(fs.existsSync(first.root)).toBe(false);
    // Ending the first owned namespace must leave the second one reachable.
    expect((await second.run(["list-sessions", "-F", "#{session_name}"])).trim()).toBe("second");
    await second.cleanup();
    expect(fs.existsSync(second.root)).toBe(false);
    await first.cleanup(); await second.cleanup();
  } finally {
    const results = await Promise.allSettled([first.cleanup(), second.cleanup()]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
}, 40000);
