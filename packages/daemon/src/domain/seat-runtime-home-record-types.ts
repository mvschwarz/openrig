/** Where a recorded home is stored: in the slot that decides the seat's home today, so its credential handling stays
 *  as it is. A seat on an account switch's home (`account_home`, whose launch unsets provider credentials) keeps that
 *  class with a new path; any other seat gets its member `env:` value, which launch, restore and status already read
 *  and which unsets nothing. A recording never moves a seat into or out of the account-switch class. */
export type RuntimeHomeSlot = "account_home" | "member_env";

export interface RuntimeHomeRecordRef {
  revision: number;
  home: string;
  slot: RuntimeHomeSlot;
  /** The original conversation (native session or thread id) it was recorded against; null when the seat had none. */
  original: string | null;
  occupantGeneration: string | null;
  operationId: string;
  recordedAt: string;
}
