export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string = 'REQUEST_FAILED'
  ) {
    super(message);
  }
}

export const notFound = (message = 'Resource not found') => new AppError(404, message, 'NOT_FOUND');
export const forbidden = (message = 'You do not have access to this resource') => new AppError(403, message, 'FORBIDDEN');
export const conflict = (message: string) => new AppError(409, message, 'CONFLICT');
