export class PlatformError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

export function fail(code, message, status) {
  throw new PlatformError(code, message, status);
}
