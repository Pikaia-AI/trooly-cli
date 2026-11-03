const sensitive =
  /^(access_token|refresh_token|id_token|api_key|client_secret|authorization|device_code|code_verifier)$/i;
const secrets = new Set<string>();
export function registerSecrets(...values: string[]): void {
  for (const value of values) if (value) secrets.add(value);
}
/** Never expose credential material, even if an upstream error echoes it. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitive.test(key) ? '[REDACTED]' : redact(item),
      ]),
    );
  }
  if (typeof value === 'string') {
    let safe = value;
    for (const secret of [...secrets, process.env.TROOLY_API_KEY].filter((item): item is string =>
      Boolean(item),
    )) {
      safe = safe.split(secret).join('[REDACTED]');
    }
    return safe;
  }
  return value;
}
export function json(value: unknown): string {
  return JSON.stringify(redact(value), null, 2);
}
