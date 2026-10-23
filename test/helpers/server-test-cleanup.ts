// Shared cleanup state must not import the server into DOM-only tests.
export const cleanup: Array<() => Promise<void>> = [];
export const cleanupEnvKeys = new Set<string>();
