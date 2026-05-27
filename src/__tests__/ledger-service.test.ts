import { LedgerService } from '../services/ledger-service';
import { Prisma } from '@prisma/client';

jest.mock('../lib/prisma', () => {
  return {
    __esModule: true,
    default: require('../__mocks__/prisma').default,
  };
});

import mockPrisma from '../__mocks__/prisma';

describe('LedgerService', () => {
  let service: LedgerService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LedgerService(mockPrisma as any);
  });

  describe('getOrderLedger', () => {
    it('should return ledger entries with balanced totals', async () => {
      const entries = [
        {
          id: 'le-1',
          orderId: 'order-1',
          account: 'ORDER_BALANCE',
          debit: new Prisma.Decimal('100.0000'),
          credit: null,
          description: 'Order created',
          eventId: 'evt-1',
          timestamp: new Date(),
        },
        {
          id: 'le-2',
          orderId: 'order-1',
          account: 'ORDER_PENDING',
          debit: null,
          credit: new Prisma.Decimal('100.0000'),
          description: 'Pending payment',
          eventId: 'evt-1',
          timestamp: new Date(),
        },
      ];

      mockPrisma.ledgerEntry.findMany.mockResolvedValue(entries);

      const result = await service.getOrderLedger('order-1');

      expect(result.entries).toHaveLength(2);
      expect(result.balance.balanced).toBe(true);
      expect(result.balance.totalDebits).toBe('100.0000');
      expect(result.balance.totalCredits).toBe('100.0000');
    });

    it('should detect unbalanced ledger', async () => {
      const entries = [
        {
          id: 'le-1',
          orderId: 'order-1',
          account: 'ORDER_BALANCE',
          debit: new Prisma.Decimal('100.0000'),
          credit: null,
          description: 'Order created',
          eventId: 'evt-1',
          timestamp: new Date(),
        },
        {
          id: 'le-2',
          orderId: 'order-1',
          account: 'ORDER_PENDING',
          debit: null,
          credit: new Prisma.Decimal('50.0000'),
          description: 'Partial',
          eventId: 'evt-1',
          timestamp: new Date(),
        },
      ];

      mockPrisma.ledgerEntry.findMany.mockResolvedValue(entries);

      const result = await service.getOrderLedger('order-1');

      expect(result.balance.balanced).toBe(false);
      expect(result.balance.totalDebits).toBe('100.0000');
      expect(result.balance.totalCredits).toBe('50.0000');
    });
  });

  describe('getAccountSummary', () => {
    it('should group entries by account type', async () => {
      const entries = [
        {
          id: 'le-1',
          orderId: 'order-1',
          account: 'ORDER_BALANCE',
          debit: new Prisma.Decimal('100.0000'),
          credit: null,
          description: 'Debit',
          eventId: 'evt-1',
          timestamp: new Date(),
        },
        {
          id: 'le-2',
          orderId: 'order-1',
          account: 'ORDER_BALANCE',
          debit: null,
          credit: new Prisma.Decimal('100.0000'),
          description: 'Credit',
          eventId: 'evt-2',
          timestamp: new Date(),
        },
        {
          id: 'le-3',
          orderId: 'order-1',
          account: 'PAYMENT_RECEIVED',
          debit: new Prisma.Decimal('100.0000'),
          credit: null,
          description: 'Payment',
          eventId: 'evt-2',
          timestamp: new Date(),
        },
      ];

      mockPrisma.ledgerEntry.findMany.mockResolvedValue(entries);

      const result = await service.getAccountSummary('order-1');

      expect(result.ORDER_BALANCE).toBeDefined();
      expect(result.ORDER_BALANCE.net).toBe('0.0000');
      expect(result.PAYMENT_RECEIVED.debits).toBe('100.0000');
    });
  });
});
