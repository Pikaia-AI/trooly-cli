import type { Command } from 'commander';
import { endpoint, type QueryFlag } from './business';
export function registerUsage(program: Command): void {
  const group = program.command('usage').description('Usage totals, events and CSV exports');
  const window: QueryFlag[] = [
    { flag: '--from <timestamp>', key: 'from', required: true },
    { flag: '--to <timestamp>', key: 'to', required: true },
    { flag: '--environment <environment>', key: 'environment' },
    { flag: '--key-id <id>', key: 'key_id' },
    { flag: '--meter <meter>', key: 'meter' },
  ];
  const subjects: QueryFlag[] = [
    { flag: '--subject-type <type>', key: 'subject_type' },
    { flag: '--subject-id <id>', key: 'subject_id' },
  ];
  endpoint(group, 'get', 'get', '/platform/v2/usage', {
    list: true,
    query: [
      ...window,
      { flag: '--granularity <value>', key: 'granularity' },
      { flag: '--group-by <value>', key: 'group_by' },
    ],
  });
  endpoint(group, 'events', 'get', '/platform/v2/usage/events', {
    list: true,
    query: [...window, ...subjects],
  });
  endpoint(group, 'export', 'get', '/platform/v2/usage/export', {
    output: true,
    query: [...window, ...subjects, { flag: '--kind <events|daily>', key: 'kind' }],
  });
}
