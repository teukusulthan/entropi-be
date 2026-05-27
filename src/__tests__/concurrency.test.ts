import { EventService } from '../services/event-service';
import { VersionConflictError } from '../lib/errors';
import { Prisma } from '@prisma/client';

jest.mock('../lib/prisma', () => {
  return {
    __esModule: true,
    default: require('../__mocks__/prisma').default,
  };
});

import mockPrisma from '../__mocks__/prisma';

describe('Concurrency', () => {
  let service: EventService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      if (typeof fn === 'function') {
        return fn(mockPrisma);
      }
      return fn;
    });
    service = new EventService(mockPrisma as any);
  });

  describe('concurrent order creation', () => {
    it('should handle 100 concurrent order creations without duplicates', async () => {
      let createCount = 0;
      mockPrisma.eventLog.findUnique.mockResolvedValue(null);
      mockPrisma.order.create.mockImplementation(async (args: any) => {
        createCount++;
        return {
          id: args.data.id,
          customerId: args.data.customerId,
          amount: new Prisma.Decimal(args.data.amount.toString()),
          paymentMethod: args.data.paymentMethod,
          status: 'PENDING',
          version: 1,
          paymentReceived: new Prisma.Decimal('0.0000'),
          feeAmount: new Prisma.Decimal('0.0000'),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      });
      mockPrisma.eventLog.create.mockImplementation(async (args: any) => ({
        id: args.data.id,
        aggregateId: args.data.aggregateId,
        eventType: args.data.eventType,
        payload: args.data.payload,
        version: args.data.version,
        timestamp: new Date(),
        idempotencyKey: args.data.idempotencyKey,
      }));
      mockPrisma.ledgerEntry.createMany.mockResolvedValue({ count: 2 });

      // Create 100 orders concurrently
      const promises = Array.from({ length: 100 }, (_, i) =>
        service.recordOrder(
          `order-concurrent-${i}`,
          '50.0000',
          `cust-${i}`,
          'card',
          `idem-concurrent-${i}`
        )
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(100);
      expect(createCount).toBe(100);

      // All should be unique orders
      const orderIds = results.map((r) => r.order?.id);
      const uniqueIds = new Set(orderIds);
      expect(uniqueIds.size).toBe(100);
    });

    it('should handle 1000 concurrent order creations within the load target', async () => {
      let createCount = 0;
      mockPrisma.eventLog.findUnique.mockResolvedValue(null);
      mockPrisma.order.create.mockImplementation(async (args: any) => {
        createCount++;
        return {
          id: args.data.id,
          customerId: args.data.customerId,
          amount: new Prisma.Decimal(args.data.amount.toString()),
          paymentMethod: args.data.paymentMethod,
          status: 'PENDING',
          version: 1,
          paymentReceived: new Prisma.Decimal('0.0000'),
          feeAmount: new Prisma.Decimal('0.0000'),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      });
      mockPrisma.eventLog.create.mockImplementation(async (args: any) => ({
        id: args.data.id,
        aggregateId: args.data.aggregateId,
        eventType: args.data.eventType,
        payload: args.data.payload,
        version: args.data.version,
        timestamp: new Date(),
        idempotencyKey: args.data.idempotencyKey,
      }));
      mockPrisma.ledgerEntry.createMany.mockResolvedValue({ count: 2 });

      const startedAt = Date.now();
      const results = await Promise.all(
        Array.from({ length: 1000 }, (_, i) =>
          service.recordOrder(
            `order-load-${i}`,
            '50.0000',
            `cust-load-${i}`,
            'card',
            `idem-load-${i}`
          )
        )
      );
      const durationMs = Date.now() - startedAt;

      expect(results).toHaveLength(1000);
      expect(createCount).toBe(1000);
      expect(new Set(results.map((r) => r.order?.id)).size).toBe(1000);
      expect(durationMs).toBeLessThan(10000);
    });
  });

  describe('concurrent payments on same order', () => {
    it('should allow only one payment via optimistic concurrency', async () => {
      let updateCallCount = 0;

      mockPrisma.eventLog.findUnique.mockResolvedValue(null);
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'order-concurrent-pay',
        status: 'PAYMENT_PROCESSING',
        version: 2,
        amount: new Prisma.Decimal('100.0000'),
      });

      // First call succeeds, second fails (version already incremented)
      mockPrisma.order.updateMany.mockImplementation(async () => {
        updateCallCount++;
        if (updateCallCount === 1) {
          return { count: 1 };
        }
        return { count: 0 }; // Conflict
      });

      mockPrisma.eventLog.create.mockResolvedValue({
        id: 'evt-pay',
        eventType: 'PAYMENT_CONFIRMED',
        version: 3,
      });
      mockPrisma.ledgerEntry.createMany.mockResolvedValue({ count: 2 });

      // Two concurrent payment attempts
      const results = await Promise.allSettled([
        service.recordPayment('order-concurrent-pay', '100.0000', 'ch_1', 'pay-a'),
        service.recordPayment('order-concurrent-pay', '100.0000', 'ch_2', 'pay-b'),
      ]);

      const successes = results.filter((r) => r.status === 'fulfilled');
      const failures = results.filter((r) => r.status === 'rejected');

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);
      expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(VersionConflictError);
    });
  });

  describe('idempotency under concurrency', () => {
    it('should return same result for duplicate idempotency keys', async () => {
      const existingEvent = {
        id: 'evt-idem',
        aggregateId: 'order-idem',
        eventType: 'ORDER_CREATED',
        idempotencyKey: 'same-key',
        version: 1,
      };
      const existingOrder = {
        id: 'order-idem',
        status: 'PENDING',
        version: 1,
      };

      mockPrisma.eventLog.findUnique.mockResolvedValue(existingEvent);
      mockPrisma.order.findUnique.mockResolvedValue(existingOrder);

      // 50 concurrent requests with same idempotency key
      const promises = Array.from({ length: 50 }, () =>
        service.recordOrder('new-order', '100.00', 'cust', 'card', 'same-key')
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(50);
      results.forEach((r) => {
        expect(r.idempotent).toBe(true);
        expect(r.event).toEqual(existingEvent);
      });

      // No new orders should have been created
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
    });
  });
});
