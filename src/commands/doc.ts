import type { Command } from 'commander';
import { basename, extname } from 'node:path';
import { stat } from 'node:fs/promises';
import type { components } from '../generated/api';
import { endpoint, fillPath, poll } from './business';
import { context } from './shared';
import { emit } from '../output/render';
import { CliError, usageError } from '../http/errors';

type Document = components['schemas']['KnowledgeDocument'];
type UploadRequest = components['schemas']['CreateDocumentUploadRequest'];
export function registerDoc(program: Command): void {
  const group = program.command('doc').description('Knowledge documents');
  endpoint(group, 'list', 'get', '/platform/v2/documents', {
    list: true,
    query: [
      { flag: '--kb <id>', key: 'knowledge_base_id' },
      { flag: '--status <status>', key: 'status' },
    ],
  });
  endpoint(group, 'get <id>', 'get', '/platform/v2/documents/{doc}');
  endpoint(group, 'delete <id>', 'delete', '/platform/v2/documents/{doc}', { destructive: true });
  endpoint(group, 'retry <id>', 'post', '/platform/v2/documents/{doc}/retry');
  group
    .command('download <id>')
    .description('Download the original document')
    .requiredOption('-o, --output <file>', 'Destination file')
    .action(async (id: string, opts, command: Command) => {
      const { client } = await context(command);
      const response = await client.request<
        components['schemas']['KnowledgeDownloadResponse']['data']
      >('GET', fillPath('/platform/v2/documents/{doc}/download', [id]));
      if (!response.data.download_url) {
        throw new CliError('The server did not return a download URL.', 1, 'INVALID_RESPONSE');
      }
      await client.download(response.data.download_url, opts.output);
    });
  group
    .command('upload <file>')
    .description('Request an upload, transfer the file and complete it')
    .requiredOption('--kb <id>', 'Target knowledge base')
    .option('--title <title>', 'Document title (defaults to the filename)')
    .option('--private', 'Create a private document')
    .option('--wait', 'Wait up to five minutes for processing')
    .action(async (file: string, opts, command: Command) => {
      const info = await stat(file).catch(() => usageError('Cannot read the upload file.'));
      if (!info.isFile()) usageError('The upload source must be a regular file.');
      const fileType = extname(file).slice(1).toLowerCase();
      const limits = { pdf: 20, docx: 15, xlsx: 15, pptx: 30, md: 1, txt: 1 };
      if (!(fileType in limits)) {
        usageError('Supported document extensions: pdf, docx, xlsx, pptx, md, txt.');
      }
      const type = fileType as UploadRequest['file_type'];
      if (info.size < 1 || info.size > limits[type] * 1024 * 1024) {
        usageError(`Invalid file size for ${type}; maximum ${limits[type]} MiB.`);
      }
      const body: UploadRequest = {
        knowledge_base_id: opts.kb,
        title: opts.title ?? basename(file),
        file_type: type,
        file_size: info.size,
        private: Boolean(opts.private),
      };
      const { client, json } = await context(command);
      const upload = await client.request<components['schemas']['KnowledgeUploadResponse']['data']>(
        'POST',
        '/platform/v2/documents/uploads',
        { body },
      );
      if (!upload.data.upload_url || !upload.data.document?.id) {
        throw new CliError(
          'The server returned an invalid upload response.',
          1,
          'INVALID_RESPONSE',
        );
      }
      await client.upload(upload.data.upload_url, file);
      const target = fillPath('/platform/v2/documents/{doc}', [upload.data.document.id]);
      const complete = await client.request<Document>('POST', `${target}/complete`);
      const document = opts.wait
        ? await poll<Document>(
            complete.data,
            async () => (await client.request<Document>('GET', target)).data,
            (value) => value.status,
          )
        : complete.data;
      emit(document, json);
    });
}
