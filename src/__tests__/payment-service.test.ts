import { PaymentService, StripeMock } from '../services/payment-service';
import { EventService } from '../services/event-service';
import { CardDeclinedError } from '../lib/errors';

describe('PaymentService', () => {
  let paymentService: PaymentService;
  let stripeMock: StripeMock;
  let mockEventService: jest.Mocked<EventService>;

  beforeEach(() => {
    jest.clearAllMocks();

    stripeMock = new StripeMock();

    mockEventService = {
      startPaymentProcessing: jest.fn(),
      recordPayment: jest.fn(),
      revertToPaymentPending: jest.fn(),
      recordOrder: jest.fn(),
      calculateFees: jest.fn(),
      dailySettlement: jest.fn(),
      verifyLedgerBalance: jest.fn(),
      processRefund: jest.fn(),
    } as any;

    paymentService = new PaymentService(stripeMock, mockEventService);
  });

  describe('processPayment - happy path', () => {
    it('should process payment successfully', async () => {
      mockEventService.startPaymentProcessing.mockResolvedValue({
        order: { id: 'order-1', status: 'PAYMENT_PROCESSING', version: 2 } as any,
        event: { id: 'evt-1' } as any,
        idempotent: false,
      });

      mockEventService.recordPayment.mockResolvedValue({
        order: { id: 'order-1', status: 'PAID', version: 3 } as any,
        event: { id: 'evt-2' } as any,
        idempotent: false,
      });

      const result = await paymentService.processPayment(
        'order-1',
        '100.0000',
        'cust-1',
        'pay-key-1'
      );

      expect(result.order?.status).toBe('PAID');
      expect(result.payment).toBeDefined();
      expect(result.payment?.status).toBe('succeeded');
      expect(mockEventService.startPaymentProcessing).toHaveBeenCalledTimes(1);
      expect(mockEventService.recordPayment).toHaveBeenCalledTimes(1);
    });
  });

  describe('processPayment - Stripe failure', () => {
    it('should revert to PENDING when card is declined', async () => {
      stripeMock.setFailMode(true);

      mockEventService.startPaymentProcessing.mockResolvedValue({
        order: { id: 'order-1', status: 'PAYMENT_PROCESSING', version: 2 } as any,
        event: { id: 'evt-1' } as any,
        idempotent: false,
      });

      mockEventService.revertToPaymentPending.mockResolvedValue({
        order: { id: 'order-1', status: 'PENDING', version: 3 } as any,
        event: { id: 'evt-revert' } as any,
        idempotent: false,
      });

      await expect(
        paymentService.processPayment('order-1', '100.0000', 'cust-1', 'pay-fail-1')
      ).rejects.toThrow(CardDeclinedError);

      expect(mockEventService.revertToPaymentPending).toHaveBeenCalledTimes(1);
      expect(mockEventService.recordPayment).not.toHaveBeenCalled();
    });
  });

  describe('processPayment - idempotency', () => {
    it('should return idempotent result when payment already fully completed', async () => {
      mockEventService.startPaymentProcessing.mockResolvedValue({
        order: { id: 'order-1', status: 'PAID', version: 3 } as any,
        event: { id: 'evt-existing' } as any,
        idempotent: true,
      });

      const result = await paymentService.processPayment(
        'order-1',
        '100.0000',
        'cust-1',
        'pay-dup-1'
      );

      expect(result.idempotent).toBe(true);
      expect(result.payment).toBeNull();
      expect(mockEventService.recordPayment).not.toHaveBeenCalled();
    });

    it('should retry charge when stuck in PAYMENT_PROCESSING (crash-recovery path)', async () => {
      // Simulates: startPaymentProcessing succeeded but recordPayment never ran
      mockEventService.startPaymentProcessing.mockResolvedValue({
        order: { id: 'order-1', status: 'PAYMENT_PROCESSING', version: 2 } as any,
        event: { id: 'evt-processing' } as any,
        idempotent: true,
      });

      mockEventService.recordPayment.mockResolvedValue({
        order: { id: 'order-1', status: 'PAID', version: 3 } as any,
        event: { id: 'evt-confirmed' } as any,
        idempotent: false,
      });

      const result = await paymentService.processPayment(
        'order-1',
        '100.0000',
        'cust-1',
        'pay-retry-1'
      );

      expect(result.order?.status).toBe('PAID');
      expect(mockEventService.recordPayment).toHaveBeenCalledTimes(1);
    });
  });

  describe('StripeMock', () => {
    it('should return a charge with succeeded status', async () => {
      const charge = await stripeMock.charge('50.00', 'cust-1');

      expect(charge.status).toBe('succeeded');
      expect(charge.amount).toBe('50.00');
      expect(charge.chargeId).toMatch(/^ch_/);
    });

    it('should throw CardDeclinedError in fail mode', async () => {
      stripeMock.setFailMode(true);

      await expect(stripeMock.charge('50.00', 'cust-1')).rejects.toThrow(CardDeclinedError);
    });
  });
});
