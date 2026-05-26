import { PrismaClient, OrderStatus, EventType, AccountType, Prisma } from '@prisma/client';
import { v4 as uuid } from 'uuid';
import { toDecimal, toFixed4, calculateFee, fromPrismaDecimal, Decimal } from '../lib/decimal';
import { validateTransition } from '../lib/state-machine';
import {
  VersionConflictError,
  OrderNotFoundError,
} from '../lib/errors';
import { config } from '../config';
import prisma from '../lib/prisma';

type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export class EventService {
  private db: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.db = prismaClient || prisma;
  }

  async recordOrder(
    orderId: string,
    amount: string,
    customerId: string,
    paymentMethod: string,
    idempotencyKey: string
  ) {
    return this.db.$transaction(
      async (tx: TxClient) => {
        const existing = await tx.eventLog.findUnique({
          where: { idempotencyKey },
        });
        if (existing) {
          const order = await tx.order.findUnique({ where: { id: existing.aggregateId } });
          return { order, event: existing, idempotent: true };
        }

        const decimalAmount = toDecimal(amount);
        const eventId = uuid();

        const order = await tx.order.create({
          data: {
            id: orderId,
            customerId,
            amount: new Prisma.Decimal(toFixed4(decimalAmount)),
            paymentMethod,
            status: OrderStatus.PENDING,
            version: 1,
          },
        });

        const event = await tx.eventLog.create({
          data: {
            id: eventId,
            aggregateId: orderId,
            eventType: EventType.ORDER_CREATED,
            payload: { amount: toFixed4(decimalAmount), customerId, paymentMethod },
            version: 1,
            idempotencyKey,
          },
        });

        await tx.ledgerEntry.createMany({
          data: [
            {
              id: uuid(),
              orderId,
              account: AccountType.ORDER_BALANCE,
              debit: new Prisma.Decimal(toFixed4(decimalAmount)),
              credit: null,
              description: `Order ${orderId} created - balance established`,
              eventId,
            },
            {
              id: uuid(),
              orderId,
              account: AccountType.ORDER_PENDING,
              debit: null,
              credit: new Prisma.Decimal(toFixed4(decimalAmount)),
              description: `Order ${orderId} created - pending payment`,
              eventId,
            },
          ],
        });

        return { order, event, idempotent: false };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000,
      }
    );
  }

  async recordPayment(
    orderId: string,
    amount: string,
    stripeChargeId: string,
    idempotencyKey: string
  ) {
    return this.db.$transaction(
      async (tx: TxClient) => {
        const existing = await tx.eventLog.findUnique({
          where: { idempotencyKey },
        });
        if (existing) {
          const order = await tx.order.findUnique({ where: { id: existing.aggregateId } });
          return { order, event: existing, idempotent: true };
        }

        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order) throw new OrderNotFoundError(orderId);

        validateTransition(order.status, OrderStatus.PAID);

        const decimalAmount = toDecimal(amount);
        const eventId = uuid();

        const updated = await tx.order.updateMany({
          where: { id: orderId, version: order.version },
          data: {
            status: OrderStatus.PAID,
            paymentReceived: new Prisma.Decimal(toFixed4(decimalAmount)),
            version: order.version + 1,
          },
        });

        if (updated.count === 0) {
          throw new VersionConflictError();
        }

        const event = await tx.eventLog.create({
          data: {
            id: eventId,
            aggregateId: orderId,
            eventType: EventType.PAYMENT_CONFIRMED,
            payload: {
              amount: toFixed4(decimalAmount),
              stripeChargeId,
            },
            version: order.version + 1,
            idempotencyKey,
          },
        });

        await tx.ledgerEntry.createMany({
          data: [
            {
              id: uuid(),
              orderId,
              account: AccountType.PAYMENT_RECEIVED,
              debit: new Prisma.Decimal(toFixed4(decimalAmount)),
              credit: null,
              description: `Payment received for order ${orderId}`,
              eventId,
            },
            {
              id: uuid(),
              orderId,
              account: AccountType.ORDER_BALANCE,
              debit: null,
              credit: new Prisma.Decimal(toFixed4(decimalAmount)),
              description: `Order ${orderId} balance cleared by payment`,
              eventId,
            },
          ],
        });

        const updatedOrder = await tx.order.findUnique({ where: { id: orderId } });

        return { order: updatedOrder, event, idempotent: false };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000,
      }
    );
  }

}

export const eventService = new EventService();
