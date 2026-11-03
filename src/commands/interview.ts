import type { Command } from 'commander';
import { endpoint } from './business';
export function registerInterview(program: Command): void {
  const group = program.command('interview').description('Qualitative interviews');
  endpoint(group, 'list <project>', 'get', '/trooly/v1/projects/{projectId}/interviews', {
    list: true,
  });
  endpoint(group, 'get <id>', 'get', '/trooly/v1/interviews/{interviewId}');
  endpoint(group, 'delete <id>', 'delete', '/trooly/v1/interviews/{interviewId}', {
    destructive: true,
  });
}
