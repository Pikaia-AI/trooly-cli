export class CliError extends Error {
  constructor(
    message: string,
    public exitCode = 1,
    public code = 'CLI_ERROR',
    public requestId?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function usageError(message: string): never {
  throw new CliError(message, 2, 'USAGE_ERROR');
}
