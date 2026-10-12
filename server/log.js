// Tiny leveled logger. LOG_LEVEL=error|warn|info|debug (default: info).
//   info  : startup, connections, translation failover events + per-minute stats
//   debug : additionally every committed text delta and every translated line
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let level = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

export function setLogLevel(name) {
  if (name in LEVELS) level = LEVELS[name];
}

export function createLogger(scope) {
  const tag = `[${scope}]`;
  const out = (min, fn) => (...args) => { if (level >= min) fn(tag, ...args); };
  return {
    error: out(LEVELS.error, console.error),
    warn: out(LEVELS.warn, console.warn),
    info: out(LEVELS.info, console.log),
    debug: out(LEVELS.debug, console.log),
  };
}
