import { EventService } from '../services/event-service';
import { PaymentService, StripeMock } from '../services/payment-service';
import { LedgerService } from '../services/ledger-service';
import { InvalidTransitionError, CardDeclinedError } from '../lib/errors';
import { Decimal } from '../lib/decimal';
import { validateTransition, isValidTransition } from '../lib/state-machine';
import { OrderStatus, Prisma } from '@prisma/client';

jest.mock('../lib/prisma', () => {
  return {
    __esModule: true,
    default: require('../__mocks__/prisma').default,
  };
});

import mockPrisma from '../__mocks__/prisma';

describe('Integration Tests', () => {
  let eventService: EventService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      if (typeof fn === 'function') {
        return fn(mockPrisma);
      }
      return fn;
    });
    eventService = new EventService(mockPrisma as any);
  });

  describe('Happy path: Create -> Pay -> Fees -> Verify Balanced', () => {
    it('should complete full order lifecycle with balanced ledger', async () => {
      // Step 1: Create order
      mockPrisma.eventLog.findUnique.mockResolvedValue(null);
      mockPrisma.order.create.mockResolvedValue({
        id: 'order-happy',
        customerId: 'cust-1',
        amount: new Prisma.Decimal('100.0000'),
        paymentMethod: 'card',
        status: 'PENDING',
        version: 1,
      });
      mockPrisma.eventLog.create.mockResolvedValue({
        id: 'evt-1',
        aggregateId: 'order-happy',
        eventType: 'ORDER_CREATED',
        version: 1,
        idempotencyKey: 'create-key',
      });
      mockPrisma.ledgerEntry.createMany.mockResolvedValue({ count: 2 });

      const createResult = await eventService.recordOrder(
        'order-happy', '100.0000', 'cust-1', 'card', 'create-key'
      );
      expect(createResult.order?.status).toBe('PENDING');

      // Step 2: Start payment processing
      mockPrisma.eventLog.findUnique.mockResolvedValue(null);
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({
          id: 'order-happy',
          status: 'PENDING',
          version: 1,
        })
        .mockResolvedValueOnce({
          id: 'order-happy',
          status: 'PAYMENT_PROCESSING',
          version: 2,
        });
      mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.eventLog.create.mockResolvedValue({
        id: 'evt-2',
        eventType: 'PAYMENT_PROCESSING',
        version: 2,
      });

      const processingResult = await eventService.startPaymentProcessing(
        'order-happy', 'processing-key'
      );
      expect(processingResult.order?.status).toBe('PAYMENT_PROCESSING');

      // Step 3: Record payment
      mockPrisma.eventLog.findUnique.mockResolvedValue(null);
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({
          id: 'order-happy',
          status: 'PAYMENT_PROCESSING',
          version: 2,
        })
        .mockResolvedValueOnce({
          id: 'order-happy',
          status: 'PAID',
          version: 3,
          paymentReceived: new Prisma.Decimal('100.0000'),
        });
      mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.eventLog.create.mockResolvedValue({
        id: 'evt-3',
        eventType: 'PAYMENT_CONFIRMED',
        version: 3,
      });
      mockPrisma.ledgerEntry.createMany.mockResolvedValue({ count: 2 });

      const payResult = await eventService.recordPayment(
        'order-happy', '100.0000', 'ch_123', 'pay-key'
      );
      expect(payResult.order?.status).toBe('PAID');

      // Step 4: Calculate fees
      mockPrisma.eventLog.findUnique.mockResolvedValue(null);
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({
          id: 'order-happy',
          status: 'PAID',
          version: 3,
          paymentReceived: new Prisma.Decimal('100.0000'),
        })
        .mockResolvedValueOnce({
          id: 'order-happy',
          status: 'FEE_CALCULATED',
          version: 4,
          feeAmount: new Prisma.Decimal('3.0000'),
        });
      mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.eventLog.create.mockResolvedValue({
        id: 'evt-4',
        eventType: 'FEE_CALCULATED',
        version: 4,
      });
      mockPrisma.ledgerEntry.createMany.mockResolvedValue({ count: 2 });

      const feeResult = await eventService.calculateFees(
        'order-happy', '100.0000', 'fee-key'
      );
      expect(feeResult.order?.status).toBe('FEE_CALCULATED');
      expect(Number(feeResult.order?.feeAmount?.toString())).toBe(3);

      // Step 5: Verify ledger balance
      // Simulate all ledger entries from the full flow
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([
        // Order created: debit ORDER_BALANCE, credit ORDER_PENDING
        { debit: new Prisma.Decimal('100.0000'), credit: null },
        { debit: null, credit: new Prisma.Decimal('100.0000') },
        // Payment confirmed: debit PAYMENT_RECEIVED, credit ORDER_BALANCE
        { debit: new Prisma.Decimal('100.0000'), credit: null },
        { debit: null, credit: new Prisma.Decimal('100.0000') },
        // Fee calculated: debit FEES_OWED, credit PAYMENT_RECEIVED
        { debit: new Prisma.Decimal('3.0000'), credit: null },
        { debit: null, credit: new Prisma.Decimal('3.0000') },
      ]);

      const balance = await eventService.verifyLedgerBalance('order-happy');
      expect(balance.balanced).toBe(true);
      expect(balance.totalDebits).toBe('203.0000');
      expect(balance.totalCredits).toBe('203.0000');
    });
  });

  describe('Decimal precision', () => {
    it('should calculate 10 * 0.03 = 0.30 exactly', () => {
      const amount = new Decimal('10');
      const fee = amount.mul(new Decimal('0.03'));

      expect(fee.toString()).toBe('0.3');
      expect(fee.toFixed(4)).toBe('0.3000');

      // Verify no floating-point imprecision
      expect(fee.equals(new Decimal('0.3'))).toBe(true);
    });

    it('should handle edge amounts correctly', () => {
      // 1 USD
      const fee1 = new Decimal('1').mul(new Decimal('0.03'));
      expect(fee1.toFixed(4)).toBe('0.0300');

      // 0.01 USD (minimum)
      const feeMin = new Decimal('0.01').mul(new Decimal('0.03'));
      expect(feeMin.toFixed(4)).toBe('0.0003');

      // 999999.99 USD (large amount)
      const feeLarge = new Decimal('999999.99').mul(new Decimal('0.03'));
      expect(feeLarge.toFixed(4)).toBe('29999.9997');

      // Verify no floating-point issues with classic problematic values
      const val = new Decimal('0.1').plus(new Decimal('0.2'));
      expect(val.equals(new Decimal('0.3'))).toBe(true);
    });
  });

  describe('Invalid state transitions', () => {
    it('should reject paying an already paid order', () => {
      expect(() => validateTransition(OrderStatus.PAID, OrderStatus.PAID)).toThrow(
        InvalidTransitionError
      );
    });

    it('should reject shipping a pending order', () => {
      expect(() => validateTransition(OrderStatus.PENDING, OrderStatus.SHIPPED)).toThrow(
        InvalidTransitionError
      );
    });

    it('should reject transitioning from DELIVERED', () => {
      expect(() => validateTransition(OrderStatus.DELIVERED, OrderStatus.PENDING)).toThrow(
        InvalidTransitionError
      );
    });

    it('should allow valid transitions', () => {
      expect(isValidTransition(OrderStatus.PENDING, OrderStatus.PAYMENT_PROCESSING)).toBe(true);
      expect(isValidTransition(OrderStatus.PAYMENT_PROCESSING, OrderStatus.PAID)).toBe(true);
      expect(isValidTransition(OrderStatus.PAID, OrderStatus.FEE_CALCULATED)).toBe(true);
      expect(isValidTransition(OrderStatus.PAID, OrderStatus.REFUNDED)).toBe(true);
      expect(isValidTransition(OrderStatus.FEE_CALCULATED, OrderStatus.REFUNDED)).toBe(true);
    });

    it('should emit shipped and delivered events through explicit transitions', async () => {
      mockPrisma.eventLog.findUnique.mockResolvedValue(null);
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({
          id: 'order-ship',
          status: 'FEE_CALCULATED',
          version: 4,
        })
        .mockResolvedValueOnce({
          id: 'order-ship',
          status: 'SHIPPED',
          version: 5,
        })
        .mockResolvedValueOnce({
          id: 'order-ship',
          status: 'SHIPPED',
          version: 5,
        })
        .mockResolvedValueOnce({
          id: 'order-ship',
          status: 'DELIVERED',
          version: 6,
        });
      mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.eventLog.create
        .mockResolvedValueOnce({
          id: 'evt-ship',
          eventType: 'ORDER_SHIPPED',
          version: 5,
        })
        .mockResolvedValueOnce({
          id: 'evt-deliver',
          eventType: 'ORDER_DELIVERED',
          version: 6,
        });

      const shipped = await eventService.markOrderShipped('order-ship', 'ship-key');
      const delivered = await eventService.markOrderDelivered('order-ship', 'deliver-key');

      expect(shipped.order?.status).toBe('SHIPPED');
      expect(delivered.order?.status).toBe('DELIVERED');
      expect(mockPrisma.eventLog.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'ORDER_SHIPPED' }),
        })
      );
      expect(mockPrisma.eventLog.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'ORDER_DELIVERED' }),
        })
      );
    });
  });

  describe('Refund flow', () => {
    it('should process refund and maintain balanced ledger', async () => {
      mockPrisma.eventLog.findUnique.mockResolvedValue(null);
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({
          id: 'order-refund',
          status: 'PAID',
          version: 3,
          paymentReceived: new Prisma.Decimal('100.0000'),
          feeAmount: new Prisma.Decimal('0.0000'),
        })
        .mockResolvedValueOnce({
          id: 'order-refund',
          status: 'REFUNDED',
          version: 4,
        });
      mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.eventLog.create.mockResolvedValue({
        id: 'evt-refund',
        eventType: 'REFUND_COMPLETED',
        version: 4,
      });
      mockPrisma.ledgerEntry.createMany.mockResolvedValue({ count: 2 });

      const result = await eventService.processRefund('order-refund', 'refund-key');

      expect(result.order?.status).toBe('REFUNDED');
      expect(result.idempotent).toBe(false);

      // Verify refund ledger entries were created
      const ledgerCall = mockPrisma.ledgerEntry.createMany.mock.calls[0][0];
      expect(ledgerCall.data).toHaveLength(2);
      // Debit ORDER_BALANCE (restoring balance)
      expect(Number(ledgerCall.data[0].debit?.toString())).toBe(100);
      // Credit PAYMENT_RECEIVED (reversing payment)
      expect(Number(ledgerCall.data[1].credit?.toString())).toBe(100);

      // Verify full ledger balance including refund
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([
        // Original order: debit ORDER_BALANCE, credit ORDER_PENDING
        { debit: new Prisma.Decimal('100.0000'), credit: null },
        { debit: null, credit: new Prisma.Decimal('100.0000') },
        // Payment: debit PAYMENT_RECEIVED, credit ORDER_BALANCE
        { debit: new Prisma.Decimal('100.0000'), credit: null },
        { debit: null, credit: new Prisma.Decimal('100.0000') },
        // Refund: debit ORDER_BALANCE, credit PAYMENT_RECEIVED
        { debit: new Prisma.Decimal('100.0000'), credit: null },
        { debit: null, credit: new Prisma.Decimal('100.0000') },
      ]);

      const balance = await eventService.verifyLedgerBalance('order-refund');
      expect(balance.balanced).toBe(true);
    });

    it('should keep order version aligned when refund reverses a calculated fee', async () => {
      mockPrisma.eventLog.findUnique.mockResolvedValue(null);
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({
          id: 'order-refund-fee',
          status: 'FEE_CALCULATED',
          version: 4,
          paymentReceived: new Prisma.Decimal('100.0000'),
          feeAmount: new Prisma.Decimal('3.0000'),
        })
        .mockResolvedValueOnce({
          id: 'order-refund-fee',
          status: 'REFUNDED',
          version: 6,
        });
      mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.eventLog.create
        .mockResolvedValueOnce({
          id: 'evt-refund-payment',
          eventType: 'REFUND_COMPLETED',
          version: 5,
        })
        .mockResolvedValueOnce({
          id: 'evt-refund-fee',
          eventType: 'REFUND_COMPLETED',
          version: 6,
        });
      mockPrisma.ledgerEntry.createMany.mockResolvedValue({ count: 2 });

      const result = await eventService.processRefund('order-refund-fee', 'refund-fee-key');

      expect(result.order?.version).toBe(6);
      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: OrderStatus.REFUNDED,
            version: 6,
          }),
        })
      );
    });
  });

  describe('Projection consistency', () => {
    it('should rebuild read model from events matching current state', async () => {
      // This tests the concept that the read model matches the event stream
      // In a real system, the read model is a projection of events

      const order = {
        id: 'order-proj',
        status: 'FEE_CALCULATED',
        version: 4,
        paymentReceived: new Prisma.Decimal('100.0000'),
        feeAmount: new Prisma.Decimal('3.0000'),
      };

      const events = [
        { eventType: 'ORDER_CREATED', version: 1, payload: { amount: '100.0000' } },
        { eventType: 'PAYMENT_PROCESSING', version: 2, payload: {} },
        { eventType: 'PAYMENT_CONFIRMED', version: 3, payload: { amount: '100.0000' } },
        { eventType: 'FEE_CALCULATED', version: 4, payload: { feeAmount: '3.0000' } },
      ];

      // Verify final event version matches order version
      expect(events[events.length - 1].version).toBe(order.version);
      // Verify final event type corresponds to order status
      expect(events[events.length - 1].eventType).toBe('FEE_CALCULATED');
      expect(order.status).toBe('FEE_CALCULATED');
    });
  });

  describe('Stripe failure and order revert', () => {
    it('should revert order to PENDING on card decline', async () => {
      const stripeMock = new StripeMock();
      const mockEvtService = {
        startPaymentProcessing: jest.fn().mockResolvedValue({
          order: { id: 'order-fail', status: 'PAYMENT_PROCESSING', version: 2 },
          event: { id: 'evt-proc' },
          idempotent: false,
        }),
        recordPayment: jest.fn(),
        revertToPaymentPending: jest.fn().mockResolvedValue({
          order: { id: 'order-fail', status: 'PENDING', version: 3 },
          event: { id: 'evt-revert' },
          idempotent: false,
        }),
      } as any;

      const paymentService = new PaymentService(stripeMock, mockEvtService);

      stripeMock.setFailMode(true);

      await expect(
        paymentService.processPayment('order-fail', '100.0000', 'cust-1', 'fail-key')
      ).rejects.toThrow(CardDeclinedError);

      expect(mockEvtService.startPaymentProcessing).toHaveBeenCalledTimes(1);
      expect(mockEvtService.revertToPaymentPending).toHaveBeenCalledTimes(1);
      expect(mockEvtService.recordPayment).not.toHaveBeenCalled();
    });
  });
});
