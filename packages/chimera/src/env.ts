const CHIMERA_CODEGRAPH_ENV_ALIASES = [
  'ALLOW_UNSAFE_NODE',
  'NO_WATCH',
  'FORCE_WATCH',
  'NO_DAEMON',
  'DAEMON_INTERNAL',
  'MCP_DEBUG',
  'MCP_TOOLS',
  'PPID_POLL_MS',
  'WATCH_DEBOUNCE_MS',
  'DAEMON_IDLE_TIMEOUT_MS',
  'WASM_RELAUNCHED',
  'HOST_PPID',
  'NO_RELAUNCH',
  'RESOLVER_CACHE_SIZE',
  'EXPLORE_LINENUMS',
  'ADAPTIVE_EXPLORE',
  'DEBUG',
  'ASCII',
  'UNICODE',
] as const;

for (const key of CHIMERA_CODEGRAPH_ENV_ALIASES) {
  const chimeraKey = `CHIMERA_${key}`;
  const codegraphKey = `CODEGRAPH_${key}`;
  const value = process.env[chimeraKey];
  if (value === undefined) continue;
  if (process.env[codegraphKey] !== undefined && process.env[codegraphKey] !== value) {
    console.warn(`${chimeraKey} overrides ${codegraphKey}`);
  }
  process.env[codegraphKey] = value;
}

export {};
