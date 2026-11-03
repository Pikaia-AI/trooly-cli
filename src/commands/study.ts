import type { Command } from 'commander';
import type { components } from '../generated/api';
import { endpoint, fillPath, poll } from './business';
import { context, readBody } from './shared';
import { emit } from '../output/render';
import { CliError, usageError } from '../http/errors';

type Archive = components['schemas']['StudyMediaArchive'];
export function registerStudy(program: Command): void {
  const group = program.command('study').description('Quantitative studies');
  endpoint(group, 'list', 'get', '/trooly/v2/projects', { list: true });
  endpoint(group, 'get <id>', 'get', '/trooly/v2/projects/{id}');
  endpoint(group, 'create', 'post', '/trooly/v2/projects', { body: 'required' });
  endpoint(group, 'update <id>', 'patch', '/trooly/v2/projects/{id}', { body: 'required' });
  endpoint(group, 'delete <id>', 'delete', '/trooly/v2/projects/{id}', { destructive: true });
  endpoint(group, 'duplicate <id>', 'post', '/trooly/v2/projects/{id}/duplicate');
  const draft = group.command('draft').description('Working draft and history');
  endpoint(draft, 'get <id>', 'get', '/trooly/v2/projects/{id}/draft');
  endpoint(draft, 'edit <id>', 'post', '/trooly/v2/projects/{id}/draft/edits', {
    body: 'required',
  });
  endpoint(draft, 'versions <id>', 'get', '/trooly/v2/projects/{id}/draft/versions', {
    list: true,
    arrayKey: 'versions',
  });
  endpoint(group, 'publish <id>', 'post', '/trooly/v2/projects/{id}/design/publish', {
    body: 'required',
  });
  endpoint(group, 'quote <id>', 'get', '/trooly/v2/projects/{id}/quote');
  endpoint(group, 'responses <id>', 'get', '/trooly/v2/projects/{id}/responses', { list: true });
  endpoint(group, 'response <id> <r>', 'get', '/trooly/v2/projects/{id}/responses/{r}');
  endpoint(group, 'report <id>', 'get', '/trooly/v2/projects/{id}/report');
  const exports = group.command('export').description('Download study exports');
  endpoint(exports, 'responses <id>', 'get', '/trooly/v2/projects/{id}/exports/responses', {
    output: true,
    query: [{ flag: '--format <csv|xlsx>', key: 'format' }],
  });
  endpoint(exports, 'transcripts <id>', 'get', '/trooly/v2/projects/{id}/exports/transcripts', {
    output: true,
  });
  group
    .command('media')
    .description('Study media')
    .command('archive <id>')
    .description('Create an archive; optionally wait for it and download')
    .option('--input <file|->', 'Optional JSON body containing interview_ids')
    .option('--wait', 'Wait up to five minutes for completion')
    .option('-o, --output <file>', 'Download the completed archive (requires --wait)')
    .action(async (id: string, opts, command: Command) => {
      if (opts.output && !opts.wait) usageError('--output requires --wait for a media archive.');
      const { client, json } = await context(command);
      const target = fillPath('/trooly/v2/projects/{id}/media/archives', [id]);
      const body = opts.input ? await readBody(opts.input) : {};
      const response = await client.request<components['schemas']['StudyCreateMediaArchiveResult']>(
        'POST',
        target,
        { body },
      );
      if (!opts.wait) {
        emit(response.data, json);
        return;
      }
      const initial = response.data.archive;
      if (!initial?.archive_id) {
        throw new CliError(
          'The server did not return an archive identifier.',
          1,
          'INVALID_RESPONSE',
        );
      }
      const archive = await poll<Archive>(
        initial,
        async () =>
          (
            await client.request<Archive>(
              'GET',
              `${target}/${encodeURIComponent(initial.archive_id!)}`,
            )
          ).data,
        (value) => value.status,
      );
      if (opts.output) {
        if (!archive.download_url) {
          throw new CliError(
            'The completed archive has no download URL. Inspect the archive and retry the download.',
            1,
            'INVALID_RESPONSE',
          );
        }
        await client.download(archive.download_url, opts.output);
      } else {
        emit(archive, json);
      }
    });
}
