import fs from "node:fs";
import path from "node:path";

export type PiCompactionRequest = {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly launchId: string | null;
  readonly submittedAt: string;
};

/** One daemon-owned current request per session, separate from runner-owned state. */
export class PiCompactionRequestStore {
  constructor(private readonly root: string) {}

  get(session: string): PiCompactionRequest | null {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file(session), "utf8"));
      if (typeof value !== "object" || value === null
        || !("nodeId" in value) || typeof value.nodeId !== "string"
        || !("attemptId" in value) || typeof value.attemptId !== "string"
        || !("launchId" in value) || (value.launchId !== null && typeof value.launchId !== "string")
        || !("submittedAt" in value) || typeof value.submittedAt !== "string") return null;
      return { nodeId: value.nodeId, attemptId: value.attemptId, launchId: value.launchId, submittedAt: value.submittedAt };
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) return null;
      throw error;
    }
  }

  set(session: string, request: PiCompactionRequest): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = this.file(session);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(request), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  delete(session: string): void {
    fs.rmSync(this.file(session), { force: true });
  }

  private file(session: string): string {
    return path.join(this.root, `${encodeURIComponent(session)}.json`);
  }
}
