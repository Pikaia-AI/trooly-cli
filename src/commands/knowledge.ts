import type { Command } from 'commander';
import type { components } from '../generated/api';
import { context } from './shared';
import { emit } from '../output/render';
import { positiveInteger } from './business';
export function registerKnowledge(program: Command): void {
  program
    .command('knowledge')
    .description('Search knowledge')
    .command('search <query>')
    .option(
      '--kb <id>',
      'Knowledge base to search',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      '--doc <id>',
      'Document to search',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option('--top-k <number>', 'Maximum results (1–10)', positiveInteger)
    .action(async (query: string, opts, command: Command) => {
      const { client, json } = await context(command);
      const body: components['schemas']['KnowledgeSearchRequest'] = {
        query,
        top_k: opts.topK ?? 5,
      };
      if (opts.kb.length) body.knowledge_base_ids = opts.kb;
      if (opts.doc.length) body.document_ids = opts.doc;
      emit((await client.request('POST', '/platform/v2/knowledge/search', { body })).data, json);
    });
}
