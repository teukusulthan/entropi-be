import { EventService } from '../services/event-service';
import { OrderNotFoundError, VersionConflictError } from '../lib/errors';
import { Prisma } from '@prisma/client';

// Mock the prisma module
jest.mock('../lib/prisma', () => {
  return {
    __esModule: true,
    default: require('../__mocks__/prisma').default,
  };
});

import mockPrisma from '../__mocks__/prisma';

describe('EventService', () => {
  let service: EventService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset $transaction to execute callback with mockPrisma
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      if (typeof fn === 'function') {
        return fn(mockPrisma);
      }
      return fn;
    });
    service = new EventService(mockPrisma as any);
  });

  describe('recordOrder', () => {
    it('should create an order with event and ledger entries', async () => {
      const orderId = 'test-order-1';
      const amount = '100.0000';
      const customerId = 'cust-1';
      const paymentMethod = 'card';
      const idempotencyKey = 'idem-1';

      mockPrisma.eventLog.findUnique.mockResolvedValue(null);
      mockPrisma.order.create.mockResolvedValue({
        id: orderId,
        customerId,
        amount: new Prisma.Decimal(amount),
        paymentMethod,
        status: 'PENDING',
        version: 1,
        paymentReceived: new Prisma.Decimal('0.0000'),
        feeAmount: new Prisma.Decimal('0.0000'),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockPrisma.eventLog.create.mockResolvedValue({
        id: 'event-1',
        aggregateId: orderId,
        eventType: 'ORDER_CREATED',
        payload: { amount, customerId, paymentMethod },
        version: 1,
        timestamp: new Date(),
        idempotencyKey,
      });
      mockPrisma.ledgerEntry.createMany.mockResolvedValue({ count: 2 });

      const result = await service.recordOrder(orderId, amount, customerId, paymentMethod, idempotencyKey);

      expect(result.order).toBeDefined();
      expect(result.event).toBeDefined();
      expect(result.idempotent).toBe(false);
      expect(mockPrisma.order.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.eventLog.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.ledgerEntry.createMany).toHaveBeenCalledTimes(1);

      // Verify ledger entries have matching amounts
      const ledgerCall = mockPrisma.ledgerEntry.createMany.mock.calls[0][0];
      expect(ledgerCall.data).toHaveLength(2);
      expect(Number(ledgerCall.data[0].debit?.toString())).toBe(100);
      expect(ledgerCall.data[0].credit).toBeNull();
      expect(ledgerCall.data[1].debit).toBeNull();
      expect(Number(ledgerCall.data[1].credit?.toString())).toBe(100);
    });

    it('should return existing event on duplicate idempotency key', async () => {
      const existingEvent = {
        id: 'event-1',
        aggregateId: 'order-1',
        eventType: 'ORDER_CREATED',
        idempotencyKey: 'idem-dup',
        version: 1,
      };
      const existingOrder = { id: 'order-1', status: 'PENDING' };

      mockPrisma.eventLog.findUnique.mockResolvedValue(existingEvent);
      mockPrisma.order.findUnique.mockResolvedValue(existingOrder);

      const result = await service.recordOrder('new-id', '50.00', 'cust', 'card', 'idem-dup');

      expect(result.idempotent).toBe(true);
      expect(result.event).toEqual(existingEvent);
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
    });
  });

  describe('recordPayment', () => {
    it('should record payment with correct state transition', async () => {
      const orderId = 'order-pay-1';

      mockPrisma.eventLog.findUnique.mockResolvedValue(null);
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({
          id: orderId,
          status: 'PAYMENT_PROCESSING',
          version: 2,
          amount: new Prisma.Decimal('100.0000'),
          paymentReceived: new Prisma.Decimal('0.0000'),
          feeAmount: new Prisma.Decimal('0.0000'),
        })
        .mockResolvedValueOnce({
          id: orderId,
          status: 'PAID',
          version: 3,
          paymentReceived: new Prisma.Decimal('100.0000'),
        });
      mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.eventLog.create.mockResolvedValue({
        id: 'event-pay-1',
        aggregateId: orderId,
        eventType: 'PAYMENT_CONFIRMED',
        version: 3,
      });
      mockPrisma.ledgerEntry.createMany.mockResolvedValue({ count: 2 });

      const result = await service.recordPayment(orderId, '100.0000', 'ch_123', 'pay-idem-1');

      expect(result.order?.status).toBe('PAID');
      expect(result.idempotent).toBe(false);
      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: orderId, version: 2 },
        })
      );
    });

    it('should throw VersionConflictError when optimistic lock fails', async () => {
      mockPrisma.eventLog.findUnique.mockResolvedValue(null);
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'order-conflict',
        status: 'PAYMENT_PROCESSING',
        version: 2,
      });
      mockPrisma.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.recordPayment('order-conflict', '100.0000', 'ch_456', 'conflict-key')
      ).rejects.toThrow(VersionConflictError);
    });

    it('should throw OrderNotFoundError for missing order', async () => {
      mockPrisma.eventLog.findUnique.mockResolvedValue(null);
      mockPrisma.order.findUnique.mockResolvedValue(null);

      await expect(
        service.recordPayment('nonexistent', '100.0000', 'ch_789', 'missing-key')
      ).rejects.toThrow(OrderNotFoundError);
    });
  });

  describe('calculateFees', () => {
    it('should calculate 3% fee with Decimal precision', async () => {
      const orderId = 'order-fee-1';

      mockPrisma.eventLog.findUnique.mockResolvedValue(null);
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({
          id: orderId,
          status: 'PAID',
          version: 3,
          amount: new Prisma.Decimal('100.0000'),
          paymentReceived: new Prisma.Decimal('100.0000'),
          feeAmount: new Prisma.Decimal('0.0000'),
        })
        .mockResolvedValueOnce({
          id: orderId,
          status: 'FEE_CALCULATED',
          version: 4,
          feeAmount: new Prisma.Decimal('3.0000'),
        });
      mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.eventLog.create.mockResolvedValue({
        id: 'event-fee-1',
        eventType: 'FEE_CALCULATED',
        version: 4,
      });
      mockPrisma.ledgerEntry.createMany.mockResolvedValue({ count: 2 });

      const result = await service.calculateFees(orderId, '100.0000', 'fee-idem-1');

      expect(Number(result.order?.feeAmount?.toString())).toBe(3);

      // Verify fee ledger entries
      const ledgerCall = mockPrisma.ledgerEntry.createMany.mock.calls[0][0];
      expect(Number(ledgerCall.data[0].debit?.toString())).toBe(3);
      expect(Number(ledgerCall.data[1].credit?.toString())).toBe(3);
    });
  });

  describe('verifyLedgerBalance', () => {
    it('should return balanced ledger', async () => {
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([
        { debit: new Prisma.Decimal('100.0000'), credit: null },
        { debit: null, credit: new Prisma.Decimal('100.0000') },
        { debit: new Prisma.Decimal('100.0000'), credit: null },
        { debit: null, credit: new Prisma.Decimal('100.0000') },
      ]);

      const result = await service.verifyLedgerBalance('order-verify');

      expect(result.balanced).toBe(true);
      expect(result.totalDebits).toBe('200.0000');
      expect(result.totalCredits).toBe('200.0000');
    });
  });
});
