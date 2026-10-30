export const SEND_SCRIPT_PREFIX = "openrig-tmux-send-";
export const SEND_SCRIPT_SUFFIX = ".txt";
const NAME = new RegExp(`^${SEND_SCRIPT_PREFIX}\\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${SEND_SCRIPT_SUFFIX.replace(".", "\\.")}$`);
export const isStagedSendName = (name: string): boolean => NAME.test(name);
