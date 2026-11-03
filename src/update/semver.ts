import { CliError } from '../http/errors';

// Strict SemVer 2.0, including the no-leading-zero rule for numeric identifiers.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export function validVersion(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value);
}
export function requireVersion(value: string): string {
  if (!validVersion(value)) {
    throw new CliError(
      'Version must be a complete semantic version (for example 1.2.3).',
      2,
      'INVALID_VERSION',
    );
  }
  return value;
}
export function compareVersions(left: string, right: string): number {
  const a = SEMVER.exec(requireVersion(left))!;
  const b = SEMVER.exec(requireVersion(right))!;
  for (let i = 1; i <= 3; i++) {
    if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) > BigInt(b[i]) ? 1 : -1;
  }
  if (!a[4] || !b[4]) {
    if (a[4] === b[4]) return 0;
    return a[4] ? -1 : 1;
  }
  const aa = a[4].split('.'),
    bb = b[4].split('.');
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === undefined) return -1;
    if (bb[i] === undefined) return 1;
    if (aa[i] === bb[i]) continue;
    const an = /^\d+$/.test(aa[i]),
      bn = /^\d+$/.test(bb[i]);
    if (an && bn) return BigInt(aa[i]) > BigInt(bb[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return aa[i] > bb[i] ? 1 : -1;
  }
  return 0;
}
