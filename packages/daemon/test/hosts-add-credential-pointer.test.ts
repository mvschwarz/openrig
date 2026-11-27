// A host entry's credential POINTER decides whose credential is sent to that entry's url.
//
// Pins:
//   - the pointer rule itself (env name shape, this daemon's own tokens, credential-shaped names, a
//     bearer file inside $OPENRIG_HOME);
//   - that `POST /api/hosts/add` refuses before the writer touches the registry, so a refused entry
//     leaves no file behind;
//   - that the shape the pairing flow writes ($OPENRIG_HOME/secrets/host-<id>.token) and a
//     per-host token name (OPENRIG_HOST_<ID>_TOKEN) still pass.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostsRoutes } from "../src/routes/hosts.js";
import {
  credentialPointerRefusal,
  DAEMON_OWN_TOKEN_ENVS,
  HOST_OWNED_PREFIX,
} from "../src/domain/hosts/host-credential-pointer.js";

function buildApp(bearerToken: string | null = null): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("settingsStore" as never, undefined);
    await next();
  });
  app.route("/api/hosts", hostsRoutes({ bearerToken }));
  return app;
}

async function add(app: Hono, body: Record<string, unknown>) {
  return app.request("/api/hosts/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const httpHost = (extra: Record<string, unknown> = {}) => ({
  id: "vm-a",
  transport: "http",
  url: "http://127.0.0.1:7433",
  ...extra,
});

describe("credentialPointerRefusal — the pointer decides whose credential travels", () => {
  const home = "/tmp/openrig-home-under-test";

  it.each(DAEMON_OWN_TOKEN_ENVS)("refuses this daemon's own token %s", (name) => {
    const refusal = credentialPointerRefusal({ bearer_env: name }, home);
    expect(refusal?.code).toBe("bearer_env_names_daemon_secret");
  });

  it("refuses a provider key by name", () => {
    const refusal = credentialPointerRefusal({ bearer_env: "ANTHROPIC_API_KEY" }, home);
    expect(refusal?.code).toBe("bearer_env_names_credential");
  });

  it("refuses a secret-shaped name that is not the host's own", () => {
    expect(credentialPointerRefusal({ bearer_env: "ACME_SECRET" }, home)?.code).toBe("bearer_env_names_credential");
    expect(credentialPointerRefusal({ bearer_env: "db_password" }, home)?.code).toBe("bearer_env_names_credential");
  });

  it("accepts a per-host token name", () => {
    expect(credentialPointerRefusal({ bearer_env: `${HOST_OWNED_PREFIX}VM_A_TOKEN` }, home)).toBeNull();
  });

  it("accepts a name the operator chose that is not credential-shaped", () => {
    expect(credentialPointerRefusal({ bearer_env: "PAIRED_VM_A" }, home)).toBeNull();
  });

  it("refuses something that is not an environment variable name", () => {
    expect(credentialPointerRefusal({ bearer_env: "OPENRIG HOST" }, home)?.code).toBe("bearer_env_invalid");
    expect(credentialPointerRefusal({ bearer_env: "1TOKEN" }, home)?.code).toBe("bearer_env_invalid");
  });

  it("refuses a bearer file outside $OPENRIG_HOME", () => {
    expect(credentialPointerRefusal({ bearer_file: "/etc/shadow" }, home)?.code).toBe("bearer_file_outside_home");
    expect(credentialPointerRefusal({ bearer_file: join(home, "..", "elsewhere.token") }, home)?.code).toBe("bearer_file_outside_home");
  });

  it("refuses a relative bearer file: the daemon would read it against its own cwd", () => {
    expect(credentialPointerRefusal({ bearer_file: "secrets/host-vm-a.token" }, home)?.code).toBe("bearer_file_not_absolute");
  });

  it("accepts the pairing flow's own path", () => {
    expect(credentialPointerRefusal({ bearer_file: join(home, "secrets", "host-vm-a.token") }, home)).toBeNull();
  });

  it("says nothing about an entry with no pointer", () => {
    expect(credentialPointerRefusal({}, home)).toBeNull();
    expect(credentialPointerRefusal({ bearer_env: undefined, bearer_file: undefined }, home)).toBeNull();
  });
});

describe("POST /api/hosts/add — refuses a pointer that would leak a credential", () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "openrig-host-pointer-"));
    savedHome = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env["OPENRIG_HOME"];
    else process.env["OPENRIG_HOME"] = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("refuses bearer_env naming a provider key, and writes nothing", async () => {
    const app = buildApp();
    const res = await add(app, httpHost({ bearer_env: "ANTHROPIC_API_KEY" }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("bearer_env_names_credential");
    expect(existsSync(join(home, "hosts.yaml"))).toBe(false);
  });

  it("refuses bearer_env naming this daemon's own bearer, and writes nothing", async () => {
    const app = buildApp();
    const res = await add(app, httpHost({ bearer_env: "OPENRIG_AUTH_BEARER_TOKEN" }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("bearer_env_names_daemon_secret");
    expect(existsSync(join(home, "hosts.yaml"))).toBe(false);
  });

  it("refuses bearer_file outside the home, and writes nothing", async () => {
    const app = buildApp();
    const res = await add(app, httpHost({ bearer_file: "/etc/shadow" }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("bearer_file_outside_home");
    expect(existsSync(join(home, "hosts.yaml"))).toBe(false);
  });

  it("still accepts the pairing flow's shape", async () => {
    mkdirSync(join(home, "secrets"), { recursive: true });
    writeFileSync(join(home, "secrets", "host-vm-a.token"), "synthetic-token\n");
    const app = buildApp();
    const res = await add(app, httpHost({ bearer_file: join(home, "secrets", "host-vm-a.token") }));
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
    expect(existsSync(join(home, "hosts.yaml"))).toBe(true);
  });

  it("still accepts a per-host token name", async () => {
    const app = buildApp();
    const res = await add(app, httpHost({ bearer_env: `${HOST_OWNED_PREFIX}VM_A_TOKEN` }));
    expect(res.status).toBe(200);
    expect(existsSync(join(home, "hosts.yaml"))).toBe(true);
  });

  it("still accepts a tokenless (anonymous) http host", async () => {
    const app = buildApp();
    const res = await add(app, httpHost());
    expect(res.status).toBe(200);
  });
});