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

  async calculateFees(
    orderId: string,
    amount: string,
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

        validateTransition(order.status, OrderStatus.FEE_CALCULATED);

        const decimalAmount = toDecimal(amount);
        const feeAmount = calculateFee(decimalAmount, config.feeRate);
        const eventId = uuid();

        const updated = await tx.order.updateMany({
          where: { id: orderId, version: order.version },
          data: {
            status: OrderStatus.FEE_CALCULATED,
            feeAmount: new Prisma.Decimal(toFixed4(feeAmount)),
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
            eventType: EventType.FEE_CALCULATED,
            payload: {
              orderAmount: toFixed4(decimalAmount),
              feeAmount: toFixed4(feeAmount),
              feeRate: config.feeRate,
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
              account: AccountType.FEES_OWED,
              debit: new Prisma.Decimal(toFixed4(feeAmount)),
              credit: null,
              description: `Fee calculated for order ${orderId}: ${toFixed4(feeAmount)}`,
              eventId,
            },
            {
              id: uuid(),
              orderId,
              account: AccountType.PAYMENT_RECEIVED,
              debit: null,
              credit: new Prisma.Decimal(toFixed4(feeAmount)),
              description: `Fee deducted from payment for order ${orderId}`,
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

  async dailySettlement(date: Date, idempotencyKey: string) {
    return this.db.$transaction(
      async (tx: TxClient) => {
        const startOfDay = new Date(date);
        startOfDay.setUTCHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setUTCHours(23, 59, 59, 999);

        const existingByKey = await tx.settlement.findUnique({
          where: { idempotencyKey },
        });
        if (existingByKey) {
          return {
            settlement: existingByKey,
            processedOrders: existingByKey.processedOrderIds as string[],
            idempotent: true,
          };
        }

        const existingSettlement = await tx.settlement.findUnique({
          where: { settlementDate: startOfDay },
        });
        if (existingSettlement) {
          return {
            settlement: existingSettlement,
            processedOrders: existingSettlement.processedOrderIds as string[],
            idempotent: true,
          };
        }

        const orders = await tx.order.findMany({
          where: {
            status: OrderStatus.DELIVERED,
            updatedAt: {
              gte: startOfDay,
              lte: endOfDay,
            },
            events: {
              none: {
                eventType: EventType.SETTLEMENT_PROCESSED,
              },
            },
          },
        });

        if (orders.length === 0) {
          const settlement = await tx.settlement.create({
            data: {
              id: uuid(),
              settlementDate: startOfDay,
              idempotencyKey,
              totalAmount: new Prisma.Decimal('0.0000'),
              totalFees: new Prisma.Decimal('0.0000'),
              netPayout: new Prisma.Decimal('0.0000'),
              orderCount: 0,
              processedOrderIds: [],
              status: 'COMPLETED',
            },
          });
          return { settlement, processedOrders: [], idempotent: false };
        }

        let totalPayments = new Decimal(0);
        let totalFees = new Decimal(0);
        const processedOrders: string[] = [];

        for (const order of orders) {
          const payment = fromPrismaDecimal(order.paymentReceived);
          const fee = fromPrismaDecimal(order.feeAmount);
          const netPayout = payment.minus(fee);

          totalPayments = totalPayments.plus(payment);
          totalFees = totalFees.plus(fee);

          const eventId = uuid();
          const settlementIdempotencyKey = `settlement-${startOfDay.toISOString()}-${order.id}`;

          await tx.eventLog.create({
            data: {
              id: eventId,
              aggregateId: order.id,
              eventType: EventType.SETTLEMENT_PROCESSED,
              payload: {
                payment: toFixed4(payment),
                fee: toFixed4(fee),
                netPayout: toFixed4(netPayout),
                settlementDate: startOfDay.toISOString(),
              },
              version: order.version + 1,
              idempotencyKey: settlementIdempotencyKey,
            },
          });

          await tx.ledgerEntry.createMany({
            data: [
              {
                id: uuid(),
                orderId: order.id,
                account: AccountType.SELLER_PAYOUT,
                debit: new Prisma.Decimal(toFixed4(netPayout)),
                credit: null,
                description: `Settlement payout for order ${order.id}`,
                eventId,
              },
              {
                id: uuid(),
                orderId: order.id,
                account: AccountType.PAYMENT_RECEIVED,
                debit: null,
                credit: new Prisma.Decimal(toFixed4(netPayout)),
                description: `Settlement deduction from payment for order ${order.id}`,
                eventId,
              },
            ],
          });

          const versionUpdated = await tx.order.updateMany({
            where: { id: order.id, version: order.version },
            data: { version: order.version + 1 },
          });
          if (versionUpdated.count === 0) {
            throw new VersionConflictError();
          }

          processedOrders.push(order.id);
        }

        const netPayout = totalPayments.minus(totalFees);

        const settlement = await tx.settlement.create({
          data: {
            id: uuid(),
            settlementDate: startOfDay,
            idempotencyKey,
            totalAmount: new Prisma.Decimal(toFixed4(totalPayments)),
            totalFees: new Prisma.Decimal(toFixed4(totalFees)),
            netPayout: new Prisma.Decimal(toFixed4(netPayout)),
            orderCount: orders.length,
            processedOrderIds: processedOrders,
            status: 'COMPLETED',
          },
        });

        return { settlement, processedOrders, idempotent: false };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 30000,
      }
    );
  }

  async verifyLedgerBalance(orderId: string) {
    const entries = await this.db.ledgerEntry.findMany({
      where: { orderId },
    });

    let totalDebits = new Decimal(0);
    let totalCredits = new Decimal(0);

    for (const entry of entries) {
      if (entry.debit) {
        totalDebits = totalDebits.plus(fromPrismaDecimal(entry.debit));
      }
      if (entry.credit) {
        totalCredits = totalCredits.plus(fromPrismaDecimal(entry.credit));
      }
    }

    return {
      orderId,
      totalDebits: toFixed4(totalDebits),
      totalCredits: toFixed4(totalCredits),
      balanced: totalDebits.equals(totalCredits),
      entries,
    };
  }

  async processRefund(orderId: string, idempotencyKey: string) {
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

        validateTransition(order.status, OrderStatus.REFUNDED);

        const paymentAmount = fromPrismaDecimal(order.paymentReceived);
        const feeAmount = fromPrismaDecimal(order.feeAmount);
        const eventId = uuid();
        const finalVersion = order.version + (feeAmount.greaterThan(0) ? 2 : 1);

        const updated = await tx.order.updateMany({
          where: { id: orderId, version: order.version },
          data: {
            status: OrderStatus.REFUNDED,
            version: finalVersion,
          },
        });

        if (updated.count === 0) {
          throw new VersionConflictError();
        }

        const event = await tx.eventLog.create({
          data: {
            id: eventId,
            aggregateId: orderId,
            eventType: EventType.REFUND_COMPLETED,
            payload: {
              refundAmount: toFixed4(paymentAmount),
              feeRefunded: toFixed4(feeAmount),
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
              account: AccountType.ORDER_BALANCE,
              debit: new Prisma.Decimal(toFixed4(paymentAmount)),
              credit: null,
              description: `Refund: restoring order balance for ${orderId}`,
              eventId,
            },
            {
              id: uuid(),
              orderId,
              account: AccountType.PAYMENT_RECEIVED,
              debit: null,
              credit: new Prisma.Decimal(toFixed4(paymentAmount)),
              description: `Refund: reversing payment for ${orderId}`,
              eventId,
            },
          ],
        });

        if (feeAmount.greaterThan(0)) {
          const feeReversalEventId = uuid();
          await tx.eventLog.create({
            data: {
              id: feeReversalEventId,
              aggregateId: orderId,
              eventType: EventType.REFUND_COMPLETED,
              payload: {
                type: 'fee_reversal',
                feeAmount: toFixed4(feeAmount),
              },
              version: order.version + 2,
              idempotencyKey: `${idempotencyKey}-fee-reversal`,
            },
          });

          await tx.ledgerEntry.createMany({
            data: [
              {
                id: uuid(),
                orderId,
                account: AccountType.PAYMENT_RECEIVED,
                debit: new Prisma.Decimal(toFixed4(feeAmount)),
                credit: null,
                description: `Refund: reversing fee deduction for ${orderId}`,
                eventId: feeReversalEventId,
              },
              {
                id: uuid(),
                orderId,
                account: AccountType.FEES_OWED,
                debit: null,
                credit: new Prisma.Decimal(toFixed4(feeAmount)),
                description: `Refund: reversing fee for ${orderId}`,
                eventId: feeReversalEventId,
              },
            ],
          });
        }

        const updatedOrder = await tx.order.findUnique({ where: { id: orderId } });

        return { order: updatedOrder, event, idempotent: false };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000,
      }
    );
  }

  async markOrderShipped(orderId: string, idempotencyKey: string) {
    return this.recordStatusTransition(
      orderId,
      OrderStatus.SHIPPED,
      EventType.ORDER_SHIPPED,
      idempotencyKey
    );
  }

  async markOrderDelivered(orderId: string, idempotencyKey: string) {
    return this.recordStatusTransition(
      orderId,
      OrderStatus.DELIVERED,
      EventType.ORDER_DELIVERED,
      idempotencyKey
    );
  }

  async startPaymentProcessing(orderId: string, idempotencyKey: string) {
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

        validateTransition(order.status, OrderStatus.PAYMENT_PROCESSING);

        const eventId = uuid();

        const updated = await tx.order.updateMany({
          where: { id: orderId, version: order.version },
          data: {
            status: OrderStatus.PAYMENT_PROCESSING,
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
            eventType: EventType.PAYMENT_PROCESSING,
            payload: { orderId },
            version: order.version + 1,
            idempotencyKey,
          },
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

  async revertToPaymentPending(orderId: string, idempotencyKey: string) {
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

        validateTransition(order.status, OrderStatus.PENDING);

        const eventId = uuid();

        const updated = await tx.order.updateMany({
          where: { id: orderId, version: order.version },
          data: {
            status: OrderStatus.PENDING,
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
            eventType: EventType.PAYMENT_FAILED,
            payload: { orderId, reason: 'payment_failed' },
            version: order.version + 1,
            idempotencyKey,
          },
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

  private async recordStatusTransition(
    orderId: string,
    nextStatus: OrderStatus,
    eventType: EventType,
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

        validateTransition(order.status, nextStatus);

        const eventId = uuid();

        const updated = await tx.order.updateMany({
          where: { id: orderId, version: order.version },
          data: {
            status: nextStatus,
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
            eventType,
            payload: {
              orderId,
              status: nextStatus,
            },
            version: order.version + 1,
            idempotencyKey,
          },
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
