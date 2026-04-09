import { ConfigStore } from "./config-store.js";
import { readOpenRigEnv } from "./openrig-compat.js";
import { fetchWithTimeout } from "./fetch-with-timeout.js";

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

interface DaemonRequestOptions {
  timeoutMs?: number;
}

interface DaemonClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class DaemonClient {
  readonly baseUrl: string;
  private fetchImpl: typeof fetch = fetch;
  private timeoutMs = 5_000;

  constructor(baseUrl?: string, options?: DaemonClientOptions) {
    if (baseUrl) {
      this.baseUrl = baseUrl;
    } else {
      const envUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
      if (envUrl) {
        this.baseUrl = envUrl;
      } else {
        // Resolve from config (env > file > defaults)
        const config = new ConfigStore().resolve();
        this.baseUrl = `http://${config.daemon.host}:${config.daemon.port}`;
      }
    }

    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.timeoutMs = options?.timeoutMs ?? 5_000;
  }

  async get<T = unknown>(path: string, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, { method: "GET" }, options);
  }

  async getText(path: string, options?: DaemonRequestOptions): Promise<DaemonResponse<string>> {
    return this.requestText(path, { method: "GET" }, options);
  }

  async post<T = unknown>(path: string, body?: unknown, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, options);
  }

  async postText<T = unknown>(path: string, text: string, contentType = "text/yaml", extraHeaders?: Record<string, string>, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, {
      method: "POST",
      headers: { "Content-Type": contentType, ...extraHeaders },
      body: text,
    }, options);
  }

  async postExpectText(path: string, body?: unknown, options?: DaemonRequestOptions): Promise<DaemonResponse<string>> {
    return this.requestText(path, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, options);
  }

  async delete<T = unknown>(path: string, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, { method: "DELETE" }, options);
  }

  private async fetch(path: string, init: RequestInit, options?: DaemonRequestOptions): Promise<Response> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    try {
      return await fetchWithTimeout(
        this.fetchImpl,
        `${this.baseUrl}${path}`,
        init,
        {
          timeoutMs,
          timeoutMessage: `Request to ${this.baseUrl}${path} timed out after ${timeoutMs}ms`,
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DaemonConnectionError(`Cannot connect to the OpenRig daemon at ${this.baseUrl}: ${msg}`);
    }
  }

  private async requestJson<T>(path: string, init: RequestInit, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    const res = await this.fetch(path, init, options);
    const data = (await res.json()) as T;
    return { status: res.status, data };
  }

  private async requestText(path: string, init: RequestInit, options?: DaemonRequestOptions): Promise<DaemonResponse<string>> {
    const res = await this.fetch(path, init, options);
    const data = await res.text();
    return { status: res.status, data };
  }
}
