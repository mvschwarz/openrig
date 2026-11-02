import { bindNativeSessionName } from "./terminal/native-session-name.js";
import type { NativeExchangeRenameIntent } from "./native-runtime-switch-journal.js";

export interface NativePhysicalSession {
  serverPid: string;
  sessionId: string;
  sessionCreated: string;
  nodeId: string;
  generation: string;
  marker?: string;
}
export type NativePhysicalObservation = { state: "absent" } | { state: "unknown" }
  | { state: "present"; session: NativePhysicalSession };
export interface NativeNameTransitionIO {
  ownsLifecycle(): boolean;
  observe(physical: string): Promise<NativePhysicalObservation>;
  /** Recheck the expected server/occupant at the command boundary. */
  rename(from: string, to: string, expected: NativePhysicalSession): Promise<void>;
  /** Recheck the expected server/occupant and current marker before setting/unsetting. */
  writeMarker(physical: string, marker: string | undefined, expected: NativePhysicalSession): Promise<void>;
}

/** A durable intent permits repair only on the same observed server and occupant. */
export class NativeNameTransition {
  constructor(private readonly nodeId: string, private readonly io: NativeNameTransitionIO) {}

  private lease(): void { if (!this.io.ownsLifecycle()) throw new Error("Native name transition lifecycle lease was lost"); }
  private same(session: NativePhysicalSession, intent: NativeExchangeRenameIntent): boolean {
    return session.nodeId === this.nodeId && session.generation === intent.generation
      && session.serverPid === intent.serverPid && session.sessionId === intent.sessionId
      && session.sessionCreated === intent.sessionCreated;
  }
  private marker(value: string | undefined): string | undefined { return value === "" ? undefined : value; }

  async prepare(from: string, to: string, generation: string): Promise<NativeExchangeRenameIntent> {
    this.lease();
    const sourceName = bindNativeSessionName(from), destinationName = bindNativeSessionName(to);
    if (sourceName.physical === destinationName.physical) throw new Error("Native name transition addresses overlap");
    const source = await this.io.observe(sourceName.physical), destination = await this.io.observe(destinationName.physical);
    this.lease();
    if (source.state !== "present" || destination.state !== "absent") throw new Error("Native name transition slots are not qualified");
    const session = source.session;
    if (session.nodeId !== this.nodeId || session.generation !== generation || this.marker(session.marker) !== sourceName.marker
      || !/^[1-9]\d*$/.test(session.serverPid) || !/^\$\d+$/.test(session.sessionId) || !/^\d+$/.test(session.sessionCreated)) {
      throw new Error("Native name transition source occupant changed or identity is not qualified");
    }
    return { schema: "openrig.native-runtime-rename/v1", from, to, generation,
      serverPid: session.serverPid, sessionId: session.sessionId, sessionCreated: session.sessionCreated };
  }

  /** Reobserve after every attempted operation; callers retain intent on any exception. */
  async resume(intent: NativeExchangeRenameIntent): Promise<void> {
    this.lease();
    if (intent.schema !== "openrig.native-runtime-rename/v1"
      || !/^[1-9]\d*$/.test(intent.serverPid) || !/^\$\d+$/.test(intent.sessionId)
      || !/^\d+$/.test(intent.sessionCreated) || !intent.generation || !this.nodeId) {
      throw new Error("Invalid native name transition intent");
    }
    const from = bindNativeSessionName(intent.from), to = bindNativeSessionName(intent.to);
    if (intent.schema !== "openrig.native-runtime-rename/v1" || from.physical === to.physical) throw new Error("Invalid native name transition intent");
    let source = await this.io.observe(from.physical), destination = await this.io.observe(to.physical);
    this.lease();
    if (source.state === "present" && destination.state === "absent") {
      if (!this.same(source.session, intent) || this.marker(source.session.marker) !== from.marker) throw new Error("Native rename source changed");
      await this.io.rename(from.physical, to.physical, source.session);
      this.lease(); source = await this.io.observe(from.physical); destination = await this.io.observe(to.physical);
    }
    this.lease();
    if (source.state !== "absent" || destination.state !== "present" || !this.same(destination.session, intent)) throw new Error("Native rename outcome is unknown");
    const currentMarker = this.marker(destination.session.marker);
    if (currentMarker !== from.marker && currentMarker !== to.marker) throw new Error("Native rename marker is foreign");
    if (currentMarker !== to.marker) {
      await this.io.writeMarker(to.physical, to.marker, destination.session);
      this.lease();
    }
    const verified = await this.io.observe(to.physical), old = await this.io.observe(from.physical);
    this.lease();
    if (old.state !== "absent" || verified.state !== "present" || !this.same(verified.session, intent)
      || this.marker(verified.session.marker) !== to.marker) throw new Error("Native rename marker repair is unconfirmed");
  }
}
