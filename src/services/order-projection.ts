import { PrismaClient, EventType } from '@prisma/client';
import prisma from '../lib/prisma';
import { fromPrismaDecimal, toFixed4, Decimal } from '../lib/decimal';
import { OrderNotFoundError } from '../lib/errors';

export class OrderProjection {
  private db: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.db = prismaClient || prisma;
  }

  async listOrders() {
    const orders = await this.db.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });

    return orders.map((order) => ({
      ...order,
      amount: fromPrismaDecimal(order.amount).toString(),
      paymentReceived: fromPrismaDecimal(order.paymentReceived).toString(),
      feeAmount: fromPrismaDecimal(order.feeAmount).toString(),
    }));
  }

  async getOrder(orderId: string) {
    const order = await this.db.order.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new OrderNotFoundError(orderId);

    const events = await this.db.eventLog.findMany({
      where: { aggregateId: orderId },
      orderBy: { version: 'asc' },
    });

    const ledgerEntries = await this.db.ledgerEntry.findMany({
      where: { orderId },
      orderBy: { timestamp: 'asc' },
    });

    let totalDebits = new Decimal(0);
    let totalCredits = new Decimal(0);
    for (const entry of ledgerEntries) {
      if (entry.debit) totalDebits = totalDebits.plus(fromPrismaDecimal(entry.debit));
      if (entry.credit) totalCredits = totalCredits.plus(fromPrismaDecimal(entry.credit));
    }

    return {
      ...order,
      amount: fromPrismaDecimal(order.amount).toString(),
      paymentReceived: fromPrismaDecimal(order.paymentReceived).toString(),
      feeAmount: fromPrismaDecimal(order.feeAmount).toString(),
      eventCount: events.length,
      ledgerEntryCount: ledgerEntries.length,
      ledgerBalanced: totalDebits.equals(totalCredits),
      lastEvent: events[events.length - 1] || null,
    };
  }

  async rebuildFromEvents(orderId: string) {
    const events = await this.db.eventLog.findMany({
      where: { aggregateId: orderId },
      orderBy: { version: 'asc' },
    });

    if (events.length === 0) {
      throw new OrderNotFoundError(orderId);
    }

    let status = 'PENDING';
    let paymentReceived = '0.0000';
    let feeAmount = '0.0000';

    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      switch (event.eventType) {
        case EventType.ORDER_CREATED:
          status = 'PENDING';
          break;
        case EventType.PAYMENT_PROCESSING:
          status = 'PAYMENT_PROCESSING';
          break;
        case EventType.PAYMENT_FAILED:
          status = 'PENDING';
          break;
        case EventType.PAYMENT_CONFIRMED:
          status = 'PAID';
          paymentReceived = payload.amount as string;
          break;
        case EventType.FEE_CALCULATED:
          status = 'FEE_CALCULATED';
          feeAmount = payload.feeAmount as string;
          break;
        case EventType.ORDER_SHIPPED:
          status = 'SHIPPED';
          break;
        case EventType.ORDER_DELIVERED:
          status = 'DELIVERED';
          break;
        case EventType.SETTLEMENT_PROCESSED:
          status = 'DELIVERED';
          break;
        case EventType.REFUND_COMPLETED:
          status = 'REFUNDED';
          break;
      }
    }

    return {
      orderId,
      status,
      paymentReceived,
      feeAmount,
      eventCount: events.length,
      version: events[events.length - 1].version,
    };
  }
}

export const orderProjection = new OrderProjection();
