import { EventService } from '../services/event-service';
import { SettlementService } from '../services/settlement-service';
import { Prisma } from '@prisma/client';

jest.mock('../lib/prisma', () => {
  return {
    __esModule: true,
    default: require('../__mocks__/prisma').default,
  };
});

import mockPrisma from '../__mocks__/prisma';

describe('SettlementService', () => {
  let eventService: EventService;
  let settlementService: SettlementService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      if (typeof fn === 'function') {
        return fn(mockPrisma);
      }
      return fn;
    });
    eventService = new EventService(mockPrisma as any);
    settlementService = new SettlementService(eventService);
  });

  describe('dailySettlement', () => {
    it('should process settlement for FEE_CALCULATED orders', async () => {
      mockPrisma.settlement.findUnique.mockResolvedValue(null);
      mockPrisma.order.findMany.mockResolvedValue([
        {
          id: 'order-settle-1',
          status: 'FEE_CALCULATED',
          version: 4,
          paymentReceived: new Prisma.Decimal('100.0000'),
          feeAmount: new Prisma.Decimal('3.0000'),
          amount: new Prisma.Decimal('100.0000'),
        },
      ]);
      mockPrisma.eventLog.create.mockResolvedValue({ id: 'settle-evt-1' });
      mockPrisma.ledgerEntry.createMany.mockResolvedValue({ count: 2 });
      mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.settlement.create.mockResolvedValue({
        id: 'settlement-1',
        settlementDate: new Date('2024-01-15'),
        idempotencyKey: 'settle-key',
        totalAmount: new Prisma.Decimal('100.0000'),
        totalFees: new Prisma.Decimal('3.0000'),
        netPayout: new Prisma.Decimal('97.0000'),
        orderCount: 1,
        processedOrderIds: ['order-settle-1'],
        status: 'COMPLETED',
      });

      const result = await eventService.dailySettlement(new Date('2024-01-15'), 'settle-key');

      expect(result.settlement.status).toBe('COMPLETED');
      expect(result.processedOrders).toHaveLength(1);
      expect(result.processedOrders[0]).toBe('order-settle-1');
    });

    it('should return existing settlement for duplicate date', async () => {
      mockPrisma.settlement.findUnique.mockResolvedValue({
        id: 'existing-settlement',
        settlementDate: new Date('2024-01-15'),
        idempotencyKey: 'settle-original',
        processedOrderIds: ['order-settle-1'],
      });

      const result = await eventService.dailySettlement(new Date('2024-01-15'), 'settle-retry');

      expect(result.idempotent).toBe(true);
      expect(result.settlement.id).toBe('existing-settlement');
      expect(result.processedOrders).toEqual(['order-settle-1']);
    });

    it('should create empty settlement when no orders found', async () => {
      mockPrisma.settlement.findUnique.mockResolvedValue(null);
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.settlement.create.mockResolvedValue({
        id: 'empty-settlement',
        settlementDate: new Date('2024-01-16'),
        idempotencyKey: 'empty-key',
        totalAmount: new Prisma.Decimal('0.0000'),
        totalFees: new Prisma.Decimal('0.0000'),
        netPayout: new Prisma.Decimal('0.0000'),
        orderCount: 0,
        processedOrderIds: [],
        status: 'COMPLETED',
      });

      const result = await eventService.dailySettlement(new Date('2024-01-16'), 'empty-key');

      expect(result.settlement.orderCount).toBe(0);
      expect(result.processedOrders).toHaveLength(0);
    });
  });

  describe('verifyLedger', () => {
    it('should delegate to eventService.verifyLedgerBalance', async () => {
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([
        { debit: new Prisma.Decimal('100.0000'), credit: null },
        { debit: null, credit: new Prisma.Decimal('100.0000') },
      ]);

      const result = await settlementService.verifyLedger('order-1');

      expect(result.balanced).toBe(true);
    });
  });
});
