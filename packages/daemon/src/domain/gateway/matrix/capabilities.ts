import type { CapabilityDescriptor } from "../protocol.js";
export const OUTBOUND_OP = "post_message";
export const ADMITTED_EVENT_TYPES = ["m.room.message", "m.reaction"] as const;
export const MATRIX_CAPABILITIES: CapabilityDescriptor = {
  kind: "capability", connectorId: "matrix-subsystem", platform: "matrix", protocolVersion: 1,
  ops: [OUTBOUND_OP], limits: { threads: true, reactionsAsAnswers: true, inbound: "long-poll", encryption: false },
};
