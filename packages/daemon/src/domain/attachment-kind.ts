/** A seat's `bindings.attachment_type`: the two built-in kinds, or one registered through
 *  `createDaemon({ seatKinds })` (see seat-kinds.ts). A leaf module, so the shared types can name
 *  it without importing the seat interfaces. */
export type AttachmentKind = "tmux" | "external_cli" | (string & {});
