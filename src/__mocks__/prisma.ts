/**
 * Mock PrismaClient for unit tests.
 * Each model's methods are mocked with jest.fn().
 * The $transaction method executes the callback with the mock client itself.
 */

const createMockModel = () => ({
  findUnique: jest.fn(),
  findMany: jest.fn(),
  findFirst: jest.fn(),
  create: jest.fn(),
  createMany: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
  delete: jest.fn(),
  deleteMany: jest.fn(),
  count: jest.fn(),
  aggregate: jest.fn(),
});

const mockPrisma = {
  order: createMockModel(),
  eventLog: createMockModel(),
  ledgerEntry: createMockModel(),
  settlement: createMockModel(),
  $transaction: jest.fn(),
  $connect: jest.fn(),
  $disconnect: jest.fn(),
};

// By default, $transaction executes the callback with the mock client
mockPrisma.$transaction.mockImplementation(async (fn: any) => {
  if (typeof fn === 'function') {
    return fn(mockPrisma);
  }
  return fn;
});

export default mockPrisma;
export { mockPrisma };
