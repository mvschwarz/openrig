import { it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";
it("the tmux environment twins default to scoped and preserve file/env opt-in precedence", () => {
  const home=mkdtempSync(join(tmpdir(),"tmux-setting-")), file=join(home,"config.json");
  const cli=new ConfigStore(file), daemon=new SettingsStore(file);
  try {
    vi.stubEnv("OPENRIG_TERMINAL_INHERIT_TMUX_ENVIRONMENT",undefined);
    expect(cli.resolveWithSource("terminal.inherit_tmux_environment")).toMatchObject({value:false,source:"default"});
    expect(daemon.resolveOne("terminal.inherit_tmux_environment")).toMatchObject({value:false,source:"default"});
    writeFileSync(file, JSON.stringify({terminal:{inheritTmuxEnvironment:true}}));
    expect(cli.resolveWithSource("terminal.inherit_tmux_environment")).toMatchObject({value:true,source:"file"});
    expect(daemon.resolveOne("terminal.inherit_tmux_environment")).toMatchObject({value:true,source:"file"});
    vi.stubEnv("OPENRIG_TERMINAL_INHERIT_TMUX_ENVIRONMENT","false");
    expect(cli.resolveWithSource("terminal.inherit_tmux_environment")).toMatchObject({value:false,source:"env"});
    expect(daemon.resolveOne("terminal.inherit_tmux_environment")).toMatchObject({value:false,source:"env"});
  } finally { vi.unstubAllEnvs(); rmSync(home,{recursive:true,force:true}); }
});
