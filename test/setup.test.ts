import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSetup } from '../src/setup/run';
import { manualCommand } from '../src/setup/skill';
import { bundledSkillDirectory } from '../src/package';
import { CLI_VERSION } from '../src/version';
import { CliError } from '../src/http/errors';
import type { Credential } from '../src/types/credential';
import type { Runner } from '../src/update/run';

const identity: Credential = {
  credential: { type: 'oauth', id: null, environment: 'live' },
  principal: { type: 'user', id: 'usr_example', name: 'Example' },
  organization: { id: 'org_example', name: 'Example', type: 'organization' },
  permissions: ['read', 'write'],
};
const githubSource = `https://github.com/Pikaia-AI/trooly-cli/tree/v${CLI_VERSION}/skills/trooly`;
const skillArgs = (source: string) => ['-y', 'skills', 'add', source, '-g', '-y'];

function dependencies() {
  return {
    installation: () => 'npm' as const,
    runner: vi.fn<Runner>().mockResolvedValue({ code: 0, output: '' }),
    login: vi.fn().mockResolvedValue(identity),
    write: vi.fn<(text: string) => void>(),
    warn: vi.fn<(text: string) => void>(),
    confirm: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('setup orchestration', () => {
  it.each(['npm', 'pnpm', 'yarn', 'bun', 'volta', 'project'] as const)(
    'does not globally reinstall an existing %s installation',
    async (method) => {
      const deps = { ...dependencies(), installation: () => method };
      const result = await runSetup({ yes: true }, deps);
      expect(result.steps.cli.status).toBe('skipped');
      expect(deps.runner).toHaveBeenCalledExactlyOnceWith('npx', skillArgs(githubSource), {
        stdoutToStderr: false,
      });
      expect(deps.login).toHaveBeenCalledTimes(1);
      expect(result.exit_code).toBe(0);
    },
  );

  it.each(['npx', 'pnpm-dlx'] as const)(
    'globally installs the currently running version for %s before skills and login',
    async (method) => {
      const deps = { ...dependencies(), installation: () => method };
      const result = await runSetup({ yes: true, profile: 'work' }, deps);
      expect(deps.runner.mock.calls).toEqual([
        ['npm', ['install', '-g', `trooly@${CLI_VERSION}`], { stdoutToStderr: false }],
        ['npx', skillArgs(githubSource), { stdoutToStderr: false }],
      ]);
      expect(deps.login).toHaveBeenCalledExactlyOnceWith({ profile: 'work' });
      expect(deps.runner.mock.invocationCallOrder[1]).toBeLessThan(
        deps.login.mock.invocationCallOrder[0],
      );
      expect(result.steps.cli.status).toBe('success');
      expect(result.steps.skill).toMatchObject({ status: 'success', source: 'github' });
      expect(result.steps.login.status).toBe('success');
      expect(result.exit_code).toBe(0);
    },
  );

  it('falls back to the bundled skill when the release tag installation fails', async () => {
    const deps = dependencies();
    deps.runner
      .mockResolvedValueOnce({ code: 1, output: 'GitHub unavailable' })
      .mockResolvedValueOnce({ code: 0, output: 'installed bundled skill' });
    const result = await runSetup({ yes: true }, deps);
    expect(deps.runner.mock.calls).toEqual([
      ['npx', skillArgs(githubSource), { stdoutToStderr: false }],
      ['npx', skillArgs(bundledSkillDirectory()), { stdoutToStderr: false }],
    ]);
    expect(result.steps.skill).toMatchObject({ status: 'success', source: 'bundled' });
    expect(deps.login).toHaveBeenCalledTimes(1);
    expect(result.exit_code).toBe(0);
  });

  it('also falls back when spawning the GitHub skill installer throws', async () => {
    const deps = dependencies();
    deps.runner
      .mockRejectedValueOnce(new Error('temporary launcher failure'))
      .mockResolvedValueOnce({ code: 0, output: '' });
    const result = await runSetup({ yes: true }, deps);
    expect(deps.runner).toHaveBeenNthCalledWith(2, 'npx', skillArgs(bundledSkillDirectory()), {
      stdoutToStderr: false,
    });
    expect(result.steps.skill).toMatchObject({ status: 'success', source: 'bundled' });
    expect(result.exit_code).toBe(0);
  });

  it('continues login when both skill sources fail and reports a manual command', async () => {
    const deps = dependencies();
    deps.runner.mockResolvedValue({ code: 1, output: 'offline' });
    const result = await runSetup({ yes: true }, deps);
    expect(deps.runner).toHaveBeenCalledTimes(2);
    expect(deps.login).toHaveBeenCalledTimes(1);
    expect(result.steps.skill.status).toBe('failed');
    expect(result.steps.skill.manual_command).toContain('npx -y skills add');
    expect(result.steps.login.status).toBe('success');
    expect(result.exit_code).toBe(1);
    expect(deps.warn.mock.calls.flat().join('')).toContain('npx -y skills add');
  });

  it('continues after both skill installer launches throw', async () => {
    const deps = dependencies();
    deps.runner.mockRejectedValue(new Error('npx unavailable'));
    const result = await runSetup({ yes: true }, deps);
    expect(deps.runner).toHaveBeenCalledTimes(2);
    expect(deps.login).toHaveBeenCalledTimes(1);
    expect(result.steps.skill.status).toBe('failed');
    expect(result.exit_code).toBe(1);
  });

  it('continues skill installation and login after the global installation fails', async () => {
    const deps = { ...dependencies(), installation: () => 'npx' as const };
    deps.runner.mockResolvedValueOnce({ code: 1, output: 'EACCES' });
    const result = await runSetup({ yes: true }, deps);
    expect(result.steps.cli.status).toBe('failed');
    expect(result.steps.cli.manual_command).toBe(`npm install -g trooly@${CLI_VERSION}`);
    expect(result.steps.skill.status).toBe('success');
    expect(result.steps.login.status).toBe('success');
    expect(deps.login).toHaveBeenCalledTimes(1);
    expect(result.exit_code).toBe(1);
    expect(deps.warn.mock.calls.flat().join('')).toContain(`npm install -g trooly@${CLI_VERSION}`);
  });

  it('continues after a global installer spawn error', async () => {
    const deps = { ...dependencies(), installation: () => 'npx' as const };
    deps.runner.mockRejectedValueOnce(new Error('npm unavailable'));
    const result = await runSetup({ yes: true }, deps);
    expect(result.steps.cli.status).toBe('failed');
    expect(result.steps.skill.status).toBe('success');
    expect(deps.login).toHaveBeenCalledTimes(1);
    expect(result.exit_code).toBe(1);
  });

  it('prints a manual command when the shell-free npm launcher cannot be resolved', async () => {
    const deps = { ...dependencies(), installation: () => 'npx' as const };
    deps.runner.mockRejectedValueOnce(
      new CliError('Cannot resolve a shell-free npm launcher.', 1, 'INSTALLER_NOT_FOUND'),
    );
    const result = await runSetup({ yes: true }, deps);
    expect(deps.warn.mock.calls.flat().join('')).toContain(`npm install -g trooly@${CLI_VERSION}`);
    expect(deps.login).toHaveBeenCalledTimes(1);
    expect(result.steps.cli.status).toBe('failed');
  });

  it('skips skill installation without suppressing login', async () => {
    const deps = dependencies();
    const result = await runSetup({ yes: true, skipSkill: true }, deps);
    expect(deps.runner).not.toHaveBeenCalled();
    expect(deps.login).toHaveBeenCalledTimes(1);
    expect(result.steps.skill.status).toBe('skipped');
    expect(result.exit_code).toBe(0);
  });

  it('skips login without suppressing skill installation', async () => {
    const deps = dependencies();
    const result = await runSetup({ yes: true, skipLogin: true }, deps);
    expect(deps.runner).toHaveBeenCalledTimes(1);
    expect(deps.login).not.toHaveBeenCalled();
    expect(result.steps.login.status).toBe('skipped');
    expect(result.exit_code).toBe(0);
  });

  it('still installs the CLI when both optional steps are skipped', async () => {
    const deps = { ...dependencies(), installation: () => 'npx' as const };
    const result = await runSetup({ yes: true, skipSkill: true, skipLogin: true }, deps);
    expect(deps.runner).toHaveBeenCalledExactlyOnceWith(
      'npm',
      ['install', '-g', `trooly@${CLI_VERSION}`],
      { stdoutToStderr: false },
    );
    expect(deps.login).not.toHaveBeenCalled();
    expect(result.steps.skill.status).toBe('skipped');
    expect(result.steps.login.status).toBe('skipped');
    expect(result.exit_code).toBe(0);
  });

  it('bypasses confirmation with --yes', async () => {
    const deps = dependencies();
    await runSetup({ yes: true }, deps);
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it('asks for confirmation before making changes without --yes', async () => {
    const deps = dependencies();
    await runSetup({}, deps);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.confirm.mock.invocationCallOrder[0]).toBeLessThan(
      deps.runner.mock.invocationCallOrder[0],
    );
  });

  it('does not proceed when confirmation is rejected', async () => {
    const deps = dependencies();
    deps.confirm.mockRejectedValue(new CliError('Cancelled.', 2, 'USAGE_ERROR'));
    await expect(runSetup({}, deps)).rejects.toMatchObject({ exitCode: 2 });
    expect(deps.runner).not.toHaveBeenCalled();
    expect(deps.login).not.toHaveBeenCalled();
  });

  it('writes exactly one JSON summary and sends all subprocess output to stderr', async () => {
    const deps = { ...dependencies(), installation: () => 'npx' as const };
    deps.runner
      .mockResolvedValueOnce({ code: 0, output: 'CLI installed' })
      .mockResolvedValueOnce({ code: 1, output: 'GitHub unavailable' })
      .mockResolvedValueOnce({ code: 0, output: 'bundled skill installed' });
    const result = await runSetup({ yes: true, json: true }, deps);
    expect(deps.write).toHaveBeenCalledTimes(1);
    const stdout = deps.write.mock.calls[0][0];
    expect(JSON.parse(stdout)).toEqual(result);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(result.version).toBe(CLI_VERSION);
    expect(deps.runner.mock.calls).toHaveLength(3);
    for (const call of deps.runner.mock.calls) {
      expect(call[2]).toEqual({ stdoutToStderr: true });
    }
  });

  it('preserves exit code 3 for unavailable OAuth in the final summary', async () => {
    const deps = dependencies();
    deps.login.mockRejectedValue(
      new CliError('OAuth login is not available on this gateway. Use TROOLY_API_KEY.', 3),
    );
    const result = await runSetup({ yes: true, json: true }, deps);
    expect(result.steps.login.status).toBe('failed');
    expect(result.steps.login.message).toContain('TROOLY_API_KEY');
    expect(result.steps.login.manual_command).toContain('trooly login');
    expect(result.exit_code).toBe(3);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(deps.write.mock.calls[0][0]).exit_code).toBe(3);
  });

  it('retains the authentication exit code even when the skill also fails', async () => {
    const deps = dependencies();
    deps.runner.mockResolvedValue({ code: 1, output: 'offline' });
    deps.login.mockRejectedValue(new CliError('Login denied.', 3, 'ACCESS_DENIED'));
    const result = await runSetup({ yes: true }, deps);
    expect(result.steps.skill.status).toBe('failed');
    expect(result.steps.login.status).toBe('failed');
    expect(result.exit_code).toBe(3);
  });
});

describe('manual setup commands', () => {
  it.each(['linux', 'darwin', 'win32'] as const)(
    'keeps fixed safe command arguments readable on %s',
    (platform) => {
      expect(manualCommand('npm', ['install', '-g', 'trooly@1.2.3'], platform)).toBe(
        'npm install -g trooly@1.2.3',
      );
    },
  );

  it.each(['linux', 'darwin'] as const)(
    'quotes spaces and shell expansions literally on %s',
    (platform) => {
      const profile = '$HOME $(whoami) `whoami`; "quoted" &';
      expect(manualCommand('trooly', ['login', '--profile', profile], platform)).toBe(
        `trooly login --profile '${profile}'`,
      );
      expect(manualCommand('npx', ['-y', 'skills', 'add', '', '-g', '-y'], platform)).toBe(
        "npx -y skills add '' -g -y",
      );
    },
  );

  it('escapes apostrophes without exposing the following text to a POSIX shell', () => {
    expect(manualCommand('trooly', ['login', '--profile', "team's workspace"], 'linux')).toBe(
      "trooly login --profile 'team'\\''s workspace'",
    );
  });

  it('uses PowerShell single-quoted literals and doubled apostrophes on Windows', () => {
    const path = "C:\\Users\\team's workspace\\$HOME $(whoami)`echo`\\skills";
    expect(manualCommand('npx', ['-y', 'skills', 'add', path, '-g', '-y'], 'win32')).toBe(
      "npx -y skills add 'C:\\Users\\team''s workspace\\$HOME $(whoami)`echo`\\skills' -g -y",
    );
  });
});
