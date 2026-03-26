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

          const result = (await holder.transport.request("capabilities")) as {
            capabilities?: string[];
          };

          const caps: Record<string, boolean> = {};
          if (result.capabilities) {
            for (const cap of result.capabilities) {
              caps[cap] = true;
            }
          }

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

  async focusSurface(surfaceId: string): Promise<CmuxResult<void>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux is not connected" };
    }
    try {
      await this.transport.request("surface.focus", { surfaceId });
      return { ok: true, data: undefined };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendText(surfaceId: string, text: string): Promise<CmuxResult<void>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux is not connected" };
    }
    try {
      await this.transport.request("surface.sendText", { surfaceId, text });
      return { ok: true, data: undefined };
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
