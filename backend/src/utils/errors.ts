export class UserFacingError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "UserFacingError";
  }
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof Error) return error.message;
  return "The conversion could not be completed.";
}
