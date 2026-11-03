import type { Command } from 'commander';
import { endpoint } from './business';
export function registerKb(program: Command): void {
  const group = program.command('kb').description('Knowledge bases');
  endpoint(group, 'list', 'get', '/platform/v2/knowledge_bases', { list: true });
  endpoint(group, 'get <id>', 'get', '/platform/v2/knowledge_bases/{kb}');
  endpoint(group, 'create', 'post', '/platform/v2/knowledge_bases', { body: 'required' });
  endpoint(group, 'update <id>', 'patch', '/platform/v2/knowledge_bases/{kb}', {
    body: 'required',
  });
  endpoint(group, 'delete <id>', 'delete', '/platform/v2/knowledge_bases/{kb}', {
    destructive: true,
  });
}
