const secretPattern = /(token|secret|key|authorization|initdata)/i;

function sanitize(value) {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, secretPattern.test(key) ? '[REDACTED]' : item])
  );
}

export function log(level, event, metadata = {}) {
  const entry = { timestamp: new Date().toISOString(), level, event, ...sanitize(metadata) };
  console[level === 'error' ? 'error' : 'log'](JSON.stringify(entry));
}

