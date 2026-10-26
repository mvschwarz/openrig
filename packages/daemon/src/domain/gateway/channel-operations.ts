import { appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { getOpenRigHome } from "../../openrig-compat.js";

/** Deliberately small, value-free snapshots: credentials, handles, message bodies,
 * and connector responses never enter the lifecycle ledger. */
export interface ChannelState {
  enabled?: boolean;
  active?: boolean;
  digest?: string;
}

export interface ChannelActor {
  actor: string;
  provenance: "transport:v1" | "claimed:v1" | "origin-unknown:v1";
  reason: string;
}

export interface ChannelOperation extends ChannelActor {
  id: string;
  at: string;
  action: "enable" | "disable" | "configure" | "binding" | "post-open-asks";
  subject: string;
  before: ChannelState;
  after: ChannelState | null;
  effect: "started" | "applied" | "no-op" | "failed";
}

export function channelStateDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A start receipt survives a crash between the effect and its completion receipt.
 * Failure to write the start refuses BEFORE the effect; incomplete is never success. */
export async function runChannelOperation<T>(input: ChannelActor & {
  action: ChannelOperation["action"];
  subject: string;
  before: ChannelState;
  run: () => Promise<{ value: T; after: ChannelState; effect: "applied" | "no-op" }>;
}, home = getOpenRigHome()): Promise<{ value: T; receipt: ChannelOperation }> {
  if (!input.actor.trim() || !input.reason.trim()) throw new Error("channel operation requires actor and reason");
  const dir = join(home, "state");
  const file = join(dir, "human-channel-operations.jsonl");
  mkdirSync(dir, { recursive: true });
  const base = {
    id: randomUUID(), actor: input.actor, provenance: input.provenance,
    reason: input.reason, action: input.action, subject: input.subject, before: input.before,
  };
  const append = (after: ChannelState | null, effect: ChannelOperation["effect"]): ChannelOperation => {
    const receipt = { ...base, at: new Date().toISOString(), after, effect };
    appendFileSync(file, JSON.stringify(receipt) + "\n", { mode: 0o600 });
    return receipt;
  };
  append(null, "started");
  try {
    const result = await input.run();
    return { value: result.value, receipt: append(result.after, result.effect) };
  } catch (error) {
    append(null, "failed");
    throw error;
  }
}
