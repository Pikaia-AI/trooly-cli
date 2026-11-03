import { describe, expect, it } from 'vitest';
import { expectPrivateWindowsDacl } from './windows-acl-support';

const account = 'S-1-5-21-111-222-333';
const admin = `${account}-500`;
const guest = `${account}-501`;
const user = `${account}-1001`;
const fullControl = (sid: string) => `(A;;FA;;;${sid})`;

describe('Windows credential DACL assertions', () => {
  it.each([
    ['numeric user', user, `D:P${fullControl(user)}`],
    ['numeric administrator', admin, `D:P${fullControl(admin)}`],
    ['numeric guest', guest, `D:P${fullControl(guest)}`],
    ['local administrator alias', admin, 'D:P(A;;FA;;;LA)'],
    ['local guest alias', guest, 'D:P(A;;FA;;;LG)'],
    ['Windows runner ACL', admin, 'D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;LA)'],
    ['optional system entry', user, `D:P${fullControl(user)}(A;;FA;;;SY)`],
    ['optional administrators entry', user, `D:P(A;;FA;;;BA)${fullControl(user)}`],
    [
      'numeric privileged SIDs',
      user,
      `D:P(A;;FA;;;S-1-5-18)${fullControl(user)}(A;;FA;;;S-1-5-32-544)`,
    ],
  ])('accepts %s', (_name, sid, sddl) => {
    expectPrivateWindowsDacl(sddl, sid);
  });

  it.each(['WD', 'BU', 'AU', 'S-1-1-0', 'S-1-5-32-545', 'S-1-5-11', `${account}-1002`, 'DA'])(
    'rejects extra principal %s',
    (sid) => {
      expect(() =>
        expectPrivateWindowsDacl(`D:P${fullControl(user)}${fullControl(sid)}`, user),
      ).toThrow();
    },
  );

  it.each([
    ['unprotected DACL', admin, 'D:AI(A;;FA;;;LA)'],
    ['missing user', admin, 'D:P(A;;FA;;;SY)(A;;FA;;;BA)'],
    ['duplicate user', admin, 'D:P(A;;FA;;;LA)(A;;FA;;;LA)'],
    ['duplicate numeric and alias user', admin, `D:P${fullControl(admin)}(A;;FA;;;LA)`],
    ['read-only user', admin, 'D:P(A;;FR;;;LA)'],
    ['deny ACE', admin, 'D:P(D;;FA;;;LA)'],
    ['inherited ACE', admin, 'D:P(A;ID;FA;;;LA)'],
    ['inherit-only ACE', admin, 'D:P(A;IO;FA;;;LA)'],
    ['wrong guest alias', admin, 'D:P(A;;FA;;;LG)'],
    ['wrong administrator alias', guest, 'D:P(A;;FA;;;LA)'],
    ['alias for unrelated user', user, 'D:P(A;;FA;;;LA)'],
    ['RID suffix on non-account SID', 'S-1-5-500', 'D:P(A;;FA;;;LA)'],
    ['foreign numeric administrator', admin, 'D:P(A;;FA;;;S-1-5-21-444-555-666-500)'],
    ['extra ACE field', user, `D:P(A;;FA;;;${user};WD)`],
    ['unparsed trailing content', user, `D:P${fullControl(user)}garbage`],
    ['unparsed content between ACEs', user, `D:P${fullControl(user)}garbage(A;;FA;;;SY)`],
    ['empty DACL', user, 'D:P'],
    ['null DACL', user, 'D:NO_ACCESS_CONTROL'],
  ])('rejects %s', (_name, sid, sddl) => {
    expect(() => expectPrivateWindowsDacl(sddl, sid)).toThrow();
  });
});
