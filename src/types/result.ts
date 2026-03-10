interface Success<T> {
  readonly ok: true;
  readonly data: T;
}

interface Failure {
  readonly ok: false;
  readonly error: Error;
}

type Result<T> = Success<T> | Failure;

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

function fail(message: string, cause?: unknown): Result<never> {
  return { ok: false, error: new Error(message, { cause }) };
}

export type { Success, Failure, Result };
export { ok, fail };
