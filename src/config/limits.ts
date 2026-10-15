/** Technical resource budgets, not account/schema business restrictions. */
export const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
export const MAX_CONFIG_DEPTH = 128;
export const MAX_CONFIG_NODES = 100_000;
export const MAX_CONFIG_READERS = 4;
export const MAX_CONFIG_WAITERS = 64;
/** Per-store confirmation work, including metadata/lock waits and cleanup. */
export const MAX_HOST_KEY_CONFIRMATIONS = 64;
