import { bundledSkillDirectory } from '../package';
import { requireVersion } from '../update/semver';
import { runProcess, type Runner } from '../update/process';

export interface StepResult {
  status: 'success' | 'skipped' | 'failed';
  message: string;
  manual_command?: string;
  source?: 'github' | 'bundled';
}

// Display only: subprocesses always receive the original argument array.
export function manualCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): string {
  return [command, ...args]
    .map((arg) => {
      if (/^[\w@./:=+-]+$/.test(arg)) return arg;
      // Windows manual commands target PowerShell; POSIX shells use the
      // close-quote / escaped-apostrophe / reopen-quote convention.
      return platform === 'win32'
        ? `'${arg.replaceAll("'", "''")}'`
        : `'${arg.replaceAll("'", "'\\''")}'`;
    })
    .join(' ');
}

export async function installSkill(
  version: string,
  dependencies: {
    runner?: Runner;
    json?: boolean;
    warn?: (text: string) => void;
  } = {},
): Promise<StepResult> {
  requireVersion(version);
  const runner = dependencies.runner ?? runProcess;
  const warn = dependencies.warn ?? ((text) => process.stderr.write(text));
  const sources = [
    ['github', `https://github.com/Pikaia-AI/trooly-cli/tree/v${version}/skills/trooly`],
    ['bundled', bundledSkillDirectory()],
  ] as const;
  let manual = '';
  for (const [source, path] of sources) {
    const args = ['-y', 'skills', 'add', path, '-g', '-y'];
    manual = manualCommand('npx', args);
    try {
      const result = await runner('npx', args, { stdoutToStderr: Boolean(dependencies.json) });
      if (result.code === 0) {
        return { status: 'success', source, message: `Installed the Trooly skill from ${source}.` };
      }
    } catch {
      // Missing launchers and process failures both allow the bundled fallback.
    }
    warn(`Skill installation from ${source} failed. Manual command: ${manual}\n`);
  }
  return {
    status: 'failed',
    message: 'Could not install the Trooly skill.',
    manual_command: manual,
  };
}
