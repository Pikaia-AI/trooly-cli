import { expect } from 'vitest';

export function expectPrivateWindowsDacl(sddl: string, sid: string): void {
  const dacl = sddl.match(/^D:((?:P|AI|AR)*)(\(.*\))$/);
  expect(dacl).not.toBeNull();
  expect(dacl![1]).toContain('P');

  // SDDL can abbreviate account SIDs: local Administrator (RID 500) and Guest (501).
  // Match the account SID shape, not an arbitrary SID that happens to end in that RID.
  const rid = sid.match(/^S-1-5-21-\d+-\d+-\d+-(500|501)$/)?.[1];
  const currentUser = new Set([sid]);
  if (rid) currentUser.add(rid === '500' ? 'LA' : 'LG');
  const privileged = new Set(['SY', 'BA', 'S-1-5-18', 'S-1-5-32-544']);

  const aces = dacl![2].match(/\([^()]*\)/g) ?? [];
  // Account for the entire DACL: never silently skip an unsupported or malformed ACE.
  expect(aces.join('')).toBe(dacl![2]);
  const principals = aces.map((ace) => {
    const fields = ace.slice(1, -1).split(';');
    const principal = fields[5];
    // Only explicit allow ACEs with full file control and no object/inheritance flags.
    expect(fields).toEqual(['A', '', 'FA', '', '', principal]);
    expect(currentUser.has(principal) || privileged.has(principal)).toBe(true);
    return principal;
  });
  // Count after alias resolution so numeric + abbreviated duplicates fail as well.
  expect(principals.filter((principal) => currentUser.has(principal))).toHaveLength(1);
}
