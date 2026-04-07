import { ConfigStore } from "./config-store.js";
import { readOpenRigEnv } from "./openrig-compat.js";

export class DaemonConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonConnectionError";
  }
}

export interface DaemonResponse<T = unknown> {
  status: number;
  data: T;
}

export class DaemonClient {
  readonly baseUrl: string;

  constructor(baseUrl?: string) {
    if (baseUrl) {
      this.baseUrl = baseUrl;
    } else {
      const envUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
      if (envUrl) {
        this.baseUrl = envUrl;
        return;
      }

      // Resolve from config (env > file > defaults)
      const config = new ConfigStore().resolve();
      this.baseUrl = `http://${config.daemon.host}:${config.daemon.port}`;
    }
  }

  async get<T = unknown>(path: string): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, { method: "GET" });
  }

  async getText(path: string): Promise<DaemonResponse<string>> {
    const res = await this.fetch(path, { method: "GET" });
    const data = await res.text();
    return { status: res.status, data };
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async postText<T = unknown>(path: string, text: string, contentType = "text/yaml", extraHeaders?: Record<string, string>): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, {
      method: "POST",
      headers: { "Content-Type": contentType, ...extraHeaders },
      body: text,
    });
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DaemonConnectionError(`Cannot connect to the OpenRig daemon at ${this.baseUrl}: ${msg}`);
    }
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<DaemonResponse<T>> {
    const res = await this.fetch(path, init);
    const data = (await res.json()) as T;
    return { status: res.status, data };
  }
}
