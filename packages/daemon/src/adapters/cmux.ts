export interface CmuxTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}

export type CmuxTransportFactory = () => Promise<CmuxTransport>;

export interface CmuxStatus {
  available: boolean;
  capabilities: Record<string, boolean>;
}

export interface CmuxWorkspace {
  id: string;
  name: string;
}

export interface CmuxSurface {
  id: string;
  title: string;
  type: string;
}

export type CmuxResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

interface CmuxAdapterOptions {
  timeoutMs: number;
}

export class CmuxAdapter {
  private status: CmuxStatus = { available: false, capabilities: {} };
  protected transport: CmuxTransport | null = null;

  constructor(
    private factory: CmuxTransportFactory,
    private options: CmuxAdapterOptions
  ) {}

  async connect(): Promise<void> {
    // Clean up previous transport if any
    if (this.transport) {
      try {
        this.transport.close();
      } catch {
        // Ignore close errors
      }
      this.transport = null;
    }

    // Track transient transport so we can clean it up if connect fails
    // after the factory succeeds (e.g. capabilities hang or throw).
    // Using an object wrapper because TS control flow doesn't track
    // mutations inside async closures for simple let bindings.
    const holder: { transport: CmuxTransport | null } = { transport: null };

    try {
      const { transport, capabilities } = await withTimeout(
        (async () => {
          holder.transport = await this.factory();

          const result = await holder.transport.request("capabilities");
          const caps = normalizeCapabilities(result);
          await holder.transport.request("workspace.current");

          return { transport: holder.transport, capabilities: caps };
        })(),
        this.options.timeoutMs
      );

      this.transport = transport;
      this.status = { available: true, capabilities };
    } catch {
      // Clean up transient transport if factory succeeded but we're failing
      if (holder.transport) {
        try {
          holder.transport.close();
        } catch {
          // Ignore close errors
        }
      }
      this.transport = null;
      this.status = { available: false, capabilities: {} };
    }
  }

  getStatus(): CmuxStatus {
    return this.status;
  }

  isAvailable(): boolean {
    return this.status.available;
  }

  async listWorkspaces(): Promise<CmuxResult<CmuxWorkspace[]>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux is not connected" };
    }
    try {
      const result = (await this.transport.request("workspace.list")) as {
        workspaces?: CmuxWorkspace[];
      };
      return { ok: true, data: result.workspaces ?? [] };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async listSurfaces(workspaceId?: string): Promise<CmuxResult<CmuxSurface[]>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux is not connected" };
    }
    try {
      const params = workspaceId != null ? { workspaceId } : undefined;
      const result = (await this.transport.request("surface.list", params)) as {
        surfaces?: CmuxSurface[];
      };
      return { ok: true, data: result.surfaces ?? [] };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async focusSurface(surfaceId: string, workspaceId?: string): Promise<CmuxResult<void>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux is not connected" };
    }
    try {
      await this.transport.request("surface.focus", { surfaceId, workspaceId });
      return { ok: true, data: undefined };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendText(surfaceId: string, text: string, workspaceId?: string): Promise<CmuxResult<void>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux is not connected" };
    }
    try {
      await this.transport.request("surface.sendText", { surfaceId, text, workspaceId });
      return { ok: true, data: undefined };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async currentWorkspace(): Promise<CmuxResult<string>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux is not connected" };
    }
    try {
      const raw = (await this.transport.request("workspace.current")) as Record<string, unknown>;
      const handle = normalizeHandle("workspace", raw["workspace_id"] ?? raw["id"]);
      if (!handle) {
        return { ok: false, code: "request_failed", message: "cmux current-workspace returned no workspace handle" };
      }
      return { ok: true, data: handle };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async createTerminalSurface(workspaceId: string): Promise<CmuxResult<string>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux is not connected" };
    }
    try {
      const raw = (await this.transport.request("surface.create", { workspaceId, type: "terminal" })) as Record<string, unknown>;
      const handle = [
        raw["created_surface_ref"],
        raw["created_surface_id"],
        raw["surface_ref"],
        raw["surface_id"],
        raw["id"],
      ]
        .map((value) => normalizeHandle("surface", value))
        .find((value): value is string => Boolean(value));
      if (!handle) {
        return { ok: false, code: "request_failed", message: "cmux new-surface returned no surface handle" };
      }
      return { ok: true, data: handle };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  // Slice 24 layout primitives — see slice 24 pre-scaffold spike result.
  // cmux RPC accepts these methods with snake_case params (verified via
  // `cmux rpc workspace.close` probe). New methods adopt snake_case
  // explicitly; existing camelCase callers (sendText, focus, etc.) are
  // unchanged at this checkpoint.

  async splitSurface(
    surfaceId: string,
    direction: "left" | "right" | "up" | "down",
    workspaceId?: string,
  ): Promise<CmuxResult<string>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux is not connected" };
    }
    try {
      const params: Record<string, unknown> = {
        surface_id: surfaceId,
        direction,
      };
      if (workspaceId != null) params["workspace_id"] = workspaceId;
      const raw = (await this.transport.request("surface.split", params)) as Record<string, unknown>;
      const handle = [
        raw["created_surface_ref"],
        raw["created_surface_id"],
        raw["surface_ref"],
        raw["surface_id"],
        raw["id"],
      ]
        .map((value) => normalizeHandle("surface", value))
        .find((value): value is string => Boolean(value));
      if (!handle) {
        return { ok: false, code: "request_failed", message: "cmux surface.split returned no surface handle" };
      }
      return { ok: true, data: handle };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async createWorkspace(name: string, cwd?: string): Promise<CmuxResult<string>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux is not connected" };
    }
    try {
      const params: Record<string, unknown> = { name };
      if (cwd != null) params["cwd"] = cwd;
      const raw = (await this.transport.request("workspace.create", params)) as Record<string, unknown>;
      const handle = [
        raw["workspace_ref"],
        raw["workspace_id"],
        raw["id"],
      ]
        .map((value) => normalizeHandle("workspace", value))
        .find((value): value is string => Boolean(value));
      if (!handle) {
        return { ok: false, code: "request_failed", message: "cmux workspace.create returned no workspace handle" };
      }
      return { ok: true, data: handle };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async closeWorkspace(workspaceId: string): Promise<CmuxResult<void>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux is not connected" };
    }
    try {
      await this.transport.request("workspace.close", { workspace_id: workspaceId });
      return { ok: true, data: undefined };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async listPaneSurfaces(paneId: string, workspaceId?: string): Promise<CmuxResult<CmuxSurface[]>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux is not connected" };
    }
    try {
      const params: Record<string, unknown> = { pane_id: paneId };
      if (workspaceId != null) params["workspace_id"] = workspaceId;
      const result = (await this.transport.request("pane.surfaces", params)) as {
        surfaces?: CmuxSurface[];
      };
      return { ok: true, data: result.surfaces ?? [] };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Query cmux for agent PIDs (sidebar metadata). Returns Map<pid, { runtime, pid }>. */
  async queryAgentPIDs(): Promise<CmuxResult<Map<number, { runtime: string; pid: number }>>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux is not connected" };
    }
    try {
      const result = (await this.transport.request("workspace.agentPIDs")) as {
        agents?: Array<{ pid: number; runtime: string }>;
      };
      const map = new Map<number, { runtime: string; pid: number }>();
      if (result.agents) {
        for (const agent of result.agents) {
          map.set(agent.pid, { runtime: agent.runtime, pid: agent.pid });
        }
      }
      return { ok: true, data: map };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }
}

function normalizeCapabilities(raw: unknown): Record<string, boolean> {
  const caps: Record<string, boolean> = {};

  if (Array.isArray(raw)) {
    for (const cap of raw) {
      if (typeof cap === "string" && cap.trim() !== "") {
        caps[cap] = true;
      }
    }
    return caps;
  }

  if (!raw || typeof raw !== "object") {
    return caps;
  }

  const record = raw as Record<string, unknown>;
  const nested = record["capabilities"];
  if (Array.isArray(nested)) {
    for (const cap of nested) {
      if (typeof cap === "string" && cap.trim() !== "") {
        caps[cap] = true;
      }
    }
    return caps;
  }

  for (const [key, value] of Object.entries(record)) {
    if (value === false || value == null) continue;
    caps[key] = true;
  }

  return caps;
}

function normalizeHandle(kind: "workspace" | "surface", value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const refPattern = kind === "workspace" ? /(workspace:[^\s]+)/ : /(surface:[^\s]+)/;
  const refMatch = trimmed.match(refPattern);
  if (refMatch) return refMatch[1];

  const withoutOK = trimmed.replace(/^OK\s+/, "");
  const firstToken = withoutOK.split(/\s+/)[0];
  return firstToken || undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Connection timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
