// The declarations TypeScript callers use (the conversation key, recorded by the CLI and the MCP server); the script itself
// is plain CommonJS so the openrig plugin can ship and run a copy of it.
export const CONVERSATION_KEY_TAG_PREFIX: string;
export function conversationKey(opts?: { pid?: number; env?: NodeJS.ProcessEnv; read?: (pid: number) => { pid: number; ppid: number; start: string; names: string[] } | null }): string | null;
export function conversationKeyTag(key: string): string;
