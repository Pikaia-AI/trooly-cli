import type { Command } from 'commander';
import { basename, extname } from 'node:path';
import { stat } from 'node:fs/promises';
import type { components } from '../generated/api';
import { endpoint, fillPath, poll } from './business';
import { context } from './shared';
import { emit } from '../output/render';
import { CliError, usageError } from '../http/errors';
import type { Envelope } from '../http/paginate';

type Document = components['schemas']['KnowledgeDocument'];
type UploadRequest = components['schemas']['CreateDocumentUploadRequest'];

const PERMISSION_DENIED_CODES = new Set(['HTTP_403', 'FORBIDDEN', 'PERMISSION_DENIED']);
const DOC_PERMISSIONS_HELP =
  '\nKnowledge document permissions:\n' +
  '  platform.knowledge_doc.read      list, get, search, and online preview (Owner, Admin, Member, Viewer, and read-only API keys)\n' +
  '  platform.knowledge_doc.download  explicit download via doc download / GET /platform/v2/documents/{doc}/download (Owner, Admin, and Member; not Viewer or read-only API keys)\n' +
  '  platform.knowledge_doc.write     upload, update, retry, and delete own documents (Owner and Admin only; not Member, Viewer, or read-only API keys)\n' +
  '  platform.knowledge_doc.manage    manage any document in the environment (Owner and Admin)\n';
const DOC_READ_HELP =
  '\nRequired permission: platform.knowledge_doc.read (Owner, Admin, Member, Viewer, and read-only API keys). Online preview remains under platform.knowledge_doc.read.\n';
const DOC_DOWNLOAD_HELP =
  '\nRequired permission: platform.knowledge_doc.download (Owner, Admin, and Member; not Viewer or read-only API keys). Online preview remains under platform.knowledge_doc.read.\n';
const DOC_WRITE_HELP =
  '\nRequired permission: platform.knowledge_doc.write (Owner and Admin only; not Member, Viewer, or read-only API keys).\n';
const DOC_MUTATE_HELP =
  '\nRequired permission: platform.knowledge_doc.write (own document) or platform.knowledge_doc.manage (Owner and Admin only; not Member, Viewer, or read-only API keys).\n';

function appendRequiredPermissionHint(error: unknown, permission: string): void {
  if (
    error instanceof CliError &&
    error.exitCode === 4 &&
    PERMISSION_DENIED_CODES.has(error.code) &&
    !error.message.includes(permission)
  ) {
    if (!/[.!?]$/.test(error.message)) error.message += '.';
    error.message += ` Required permission: ${permission}.`;
  }
}

export function registerDoc(program: Command): void {
  const group = program
    .command('doc')
    .description('Knowledge documents')
    .addHelpText('after', DOC_PERMISSIONS_HELP);
  endpoint(group, 'list', 'get', '/platform/v2/documents', {
    list: true,
    query: [
      { flag: '--kb <id>', key: 'knowledge_base_id' },
      { flag: '--status <status>', key: 'status' },
    ],
  }).addHelpText('after', DOC_READ_HELP);
  endpoint(group, 'get <id>', 'get', '/platform/v2/documents/{doc}').addHelpText(
    'after',
    DOC_READ_HELP,
  );
  endpoint(group, 'delete <id>', 'delete', '/platform/v2/documents/{doc}', {
    destructive: true,
  }).addHelpText('after', DOC_MUTATE_HELP);
  endpoint(group, 'retry <id>', 'post', '/platform/v2/documents/{doc}/retry').addHelpText(
    'after',
    DOC_MUTATE_HELP,
  );
  group
    .command('download <id>')
    .description('Download the original document')
    .requiredOption('-o, --output <file>', 'Destination file')
    .addHelpText('after', DOC_DOWNLOAD_HELP)
    .action(async (id: string, opts, command: Command) => {
      const { client } = await context(command);
      let response: Envelope<components['schemas']['KnowledgeDownloadResponse']['data']>;
      try {
        response = await client.request<components['schemas']['KnowledgeDownloadResponse']['data']>(
          'GET',
          fillPath('/platform/v2/documents/{doc}/download', [id]),
        );
      } catch (error) {
        appendRequiredPermissionHint(error, 'platform.knowledge_doc.download');
        throw error;
      }
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
    .option('--wait', 'Wait up to five minutes for processing')
    .addHelpText('after', DOC_WRITE_HELP)
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
      };
      const { client, json } = await context(command);
      let upload: Envelope<components['schemas']['KnowledgeUploadResponse']['data']>;
      try {
        upload = await client.request<components['schemas']['KnowledgeUploadResponse']['data']>(
          'POST',
          '/platform/v2/documents/uploads',
          { body },
        );
      } catch (error) {
        appendRequiredPermissionHint(error, 'platform.knowledge_doc.write');
        throw error;
      }
      if (!upload.data.upload_url || !upload.data.document?.id) {
        throw new CliError(
          'The server returned an invalid upload response.',
          1,
          'INVALID_RESPONSE',
        );
      }
      await client.upload(upload.data.upload_url, file);
      const target = fillPath('/platform/v2/documents/{doc}', [upload.data.document.id]);
      let complete: Envelope<Document>;
      try {
        complete = await client.request<Document>('POST', `${target}/complete`);
      } catch (error) {
        appendRequiredPermissionHint(error, 'platform.knowledge_doc.write');
        throw error;
      }
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
