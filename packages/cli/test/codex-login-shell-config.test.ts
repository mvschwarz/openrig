import { it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";
it("launch.codex_login_shell defaults off in both stores, with file and env precedence", () => {
  const home=mkdtempSync(join(tmpdir(),"codex-login-shell-")), file=join(home,"config.json");
  const cli=new ConfigStore(file), daemon=new SettingsStore(file);
  try {
    vi.stubEnv("OPENRIG_LAUNCH_CODEX_LOGIN_SHELL",undefined);
    expect(cli.resolveWithSource("launch.codex_login_shell")).toMatchObject({value:false,source:"default"});
    expect(daemon.resolveOne("launch.codex_login_shell")).toMatchObject({value:false,source:"default"});
    writeFileSync(file, JSON.stringify({launch:{codexLoginShell:true}}));
    expect(cli.resolveWithSource("launch.codex_login_shell")).toMatchObject({value:true,source:"file"});
    expect(daemon.resolveOne("launch.codex_login_shell")).toMatchObject({value:true,source:"file"});
    vi.stubEnv("OPENRIG_LAUNCH_CODEX_LOGIN_SHELL","false");
    expect(cli.resolveWithSource("launch.codex_login_shell")).toMatchObject({value:false,source:"env"});
    expect(daemon.resolveOne("launch.codex_login_shell")).toMatchObject({value:false,source:"env"});
  } finally { vi.unstubAllEnvs(); rmSync(home,{recursive:true,force:true}); }
});
