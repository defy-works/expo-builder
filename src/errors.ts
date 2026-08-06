/** A problem with how the command was invoked or configured. Exit code 1. */
export class UsageError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** A build, remote, or VM failure. Exit code 2. */
export class BuildError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = "BuildError";
  }
}

export function exitCodeFor(err: unknown): number {
  if (err instanceof BuildError) return 2;
  return 1;
}

export function formatError(err: unknown): string {
  if (err instanceof UsageError || err instanceof BuildError) {
    return err.hint ? `${err.message}\n\n${err.hint}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return "An unknown error occurred";
}
