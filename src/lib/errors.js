class AppError extends Error {
  constructor(message, status = 500, code = 'INTERNAL_ERROR', details) {
    super(message);
    this.name = this.constructor.name;
    this.status = status; this.code = code; this.details = details;
  }
}
class BadRequestError    extends AppError { constructor(m='Bad request',d){super(m,400,'BAD_REQUEST',d);} }
class ValidationError    extends AppError { constructor(m='Validation failed',d){super(m,422,'VALIDATION_ERROR',d);} }
class UnauthorizedError  extends AppError { constructor(m='Unauthorized',d){super(m,401,'UNAUTHORIZED',d);} }
class ForbiddenError     extends AppError { constructor(m='Forbidden',d){super(m,403,'FORBIDDEN',d);} }
class NotFoundError      extends AppError { constructor(m='Not found',d){super(m,404,'NOT_FOUND',d);} }
class ConflictError      extends AppError { constructor(m='Conflict',d){super(m,409,'CONFLICT',d);} }
class TooManyRequestsError extends AppError { constructor(m='Too many requests',d){super(m,429,'RATE_LIMITED',d);} }

module.exports = { AppError, BadRequestError, ValidationError, UnauthorizedError,
  ForbiddenError, NotFoundError, ConflictError, TooManyRequestsError };
