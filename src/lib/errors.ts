export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class VersionConflictError extends AppError {
  constructor(message = 'Optimistic concurrency conflict: version mismatch') {
    super(message, 409, 'VERSION_CONFLICT');
  }
}

export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string) {
    super(
      `Invalid state transition from ${from} to ${to}`,
      422,
      'INVALID_TRANSITION'
    );
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(message = 'Idempotency key already used for a different operation') {
    super(message, 409, 'IDEMPOTENCY_CONFLICT');
  }
}

export class OrderNotFoundError extends AppError {
  constructor(orderId: string) {
    super(`Order not found: ${orderId}`, 404, 'ORDER_NOT_FOUND');
  }
}

export class CardDeclinedError extends AppError {
  constructor(message = 'Card declined') {
    super(message, 402, 'CARD_DECLINED');
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}
