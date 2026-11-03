import type { Command } from 'commander';
import { endpoint } from './business';
export function registerProject(program: Command): void {
  const group = program.command('project').description('Qualitative projects');
  endpoint(group, 'list', 'get', '/trooly/v1/projects', { list: true });
  endpoint(group, 'get <id>', 'get', '/trooly/v1/projects/{projectId}');
  endpoint(group, 'create', 'post', '/trooly/v1/projects', { body: 'required' });
  endpoint(group, 'update <id>', 'put', '/trooly/v1/projects/{projectId}', { body: 'required' });
  endpoint(group, 'delete <id>', 'delete', '/trooly/v1/projects/{projectId}', {
    destructive: true,
  });
  endpoint(group, 'launch <id>', 'post', '/trooly/v1/projects/{projectId}/launch', {
    destructive: true,
    body: 'optional',
  });
  endpoint(group, 'terminate <id>', 'post', '/trooly/v1/projects/{projectId}/terminate', {
    destructive: true,
  });
  endpoint(group, 'report <id>', 'get', '/trooly/v1/projects/{projectId}/report');
}
