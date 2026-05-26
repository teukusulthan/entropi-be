import { OrderStatus } from '@prisma/client';
import { InvalidTransitionError } from './errors';

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.PAYMENT_PROCESSING],
  [OrderStatus.PAYMENT_PROCESSING]: [OrderStatus.PAID, OrderStatus.PENDING],
  [OrderStatus.PAID]: [OrderStatus.FEE_CALCULATED, OrderStatus.REFUNDED],
  [OrderStatus.FEE_CALCULATED]: [OrderStatus.SHIPPED, OrderStatus.REFUNDED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.REFUNDED]: [],
};

export function isValidTransition(
  current: OrderStatus,
  next: OrderStatus
): boolean {
  const allowed = VALID_TRANSITIONS[current];
  return allowed !== undefined && allowed.includes(next);
}

export function validateTransition(
  current: OrderStatus,
  next: OrderStatus
): void {
  if (!isValidTransition(current, next)) {
    throw new InvalidTransitionError(current, next);
  }
}
