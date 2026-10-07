export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = 'Record') => new AppError(404, 'not_found', `${what} not found`);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'forbidden', message);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);
export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details);
export const invalid = (message: string, details?: unknown) => new AppError(422, 'validation_failed', message, details);
