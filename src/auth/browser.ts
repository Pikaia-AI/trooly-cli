import { spawn } from 'node:child_process';
import { usageError } from '../http/errors';

export function openBrowser(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  ) {
    usageError('Unsupported browser URL.');
  }
  let command = 'xdg-open';
  if (process.platform === 'darwin') {
    command = 'open';
  } else if (process.platform === 'win32') {
    command = 'rundll32';
  }
  const args =
    process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
  const child = spawn(command, args, { shell: false, detached: true, stdio: 'ignore' });
  child.on('error', () => {
    process.stderr.write('Could not open a browser. Open the displayed URL manually.\n');
  });
  child.unref();
}
