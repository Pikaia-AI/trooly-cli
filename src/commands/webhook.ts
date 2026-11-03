import type { Command } from 'commander';
import { endpoint } from './business';
export function registerWebhook(program: Command): void {
  const group = program.command('webhook').description('Webhooks and delivery history');
  endpoint(group, 'list', 'get', '/platform/v2/webhooks', { list: true });
  endpoint(group, 'create', 'post', '/platform/v2/webhooks', { body: 'required' });
  endpoint(group, 'delete <id>', 'delete', '/platform/v2/webhooks/{webhookId}', {
    destructive: true,
  });
  endpoint(group, 'deliveries <id>', 'get', '/platform/v2/webhooks/{webhookId}/deliveries', {
    list: true,
  });
  endpoint(
    group,
    'redeliver <id> <delivery>',
    'post',
    '/platform/v2/webhooks/{webhookId}/deliveries/{deliveryId}/redeliver',
  );
}
