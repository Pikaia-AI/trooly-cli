import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../src/http/errors';
import { emitError } from '../src/output/render';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('error output', () => {
  it('writes the English human-readable format to stderr and preserves the exit code', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    expect(
      emitError(new CliError('Authorization was denied.', 3, 'ACCESS_DENIED', 'req-123')),
    ).toBe(3);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      'Error: Authorization was denied. (ACCESS_DENIED, request_id=req-123)\n',
    );
    expect(stdout).not.toHaveBeenCalled();
  });

  it.each([new Error('Something failed.'), 'Something failed.'])(
    'uses the default error code and missing request ID for generic failures',
    (error) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      expect(emitError(error)).toBe(1);
      expect(stderr).toHaveBeenCalledExactlyOnceWith(
        'Error: Something failed. (CLI_ERROR, request_id=-)\n',
      );
    },
  );

  it('redacts secrets from every human-readable error field', () => {
    vi.stubEnv('TROOLY_API_KEY', 'fake-render-secret');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(
      emitError(
        new CliError(
          'Rejected fake-render-secret',
          3,
          'CODE_fake-render-secret',
          'req-fake-render-secret',
        ),
      ),
    ).toBe(3);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      'Error: Rejected [REDACTED] (CODE_[REDACTED], request_id=req-[REDACTED])\n',
    );
  });

  it('preserves the JSON error envelope and secret redaction', () => {
    vi.stubEnv('TROOLY_API_KEY', 'fake-render-json-secret');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(
      emitError(
        new CliError('Rejected fake-render-json-secret', 3, 'ACCESS_DENIED', 'req-json', {
          access_token: 'fake-token',
          reason: 'Authorization was denied.',
        }),
        true,
      ),
    ).toBe(3);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        error: {
          code: 'ACCESS_DENIED',
          message: 'Rejected [REDACTED]',
          details: { access_token: '[REDACTED]', reason: 'Authorization was denied.' },
        },
        meta: { request_id: 'req-json' },
      }) + '\n',
    );
  });
});
