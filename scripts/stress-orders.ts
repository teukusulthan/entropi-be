import { randomUUID } from 'crypto';

const apiBase = process.env.API_BASE_URL || 'http://localhost:3001/api';
const orderCount = Number(process.env.ORDER_COUNT || '1000');
const targetMs = Number(process.env.TARGET_MS || '10000');

type CreatedOrder = {
  order: {
    id: string;
    amount: string;
  };
};

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${path} failed with ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${path} failed with ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

async function createOrder(index: number): Promise<CreatedOrder> {
  return postJson<CreatedOrder>('/orders', {
    amount: '10.0000',
    customerId: `stress-customer-${index}`,
    paymentMethod: 'card',
    idempotencyKey: `stress-create-${randomUUID()}`,
  });
}

async function main() {
  const startedAt = Date.now();
  const results = await Promise.all(Array.from({ length: orderCount }, (_, index) => createOrder(index)));
  const durationMs = Date.now() - startedAt;
  const uniqueIds = new Set(results.map((result) => result.order.id));

  if (uniqueIds.size !== orderCount) {
    throw new Error(`Expected ${orderCount} unique orders, got ${uniqueIds.size}`);
  }

  const sampleIds = Array.from(uniqueIds).slice(0, Math.min(25, uniqueIds.size));
  const verifications = await Promise.all(
    sampleIds.map((id) => getJson<{ balanced: boolean }>(`/verify-ledger/${id}`))
  );

  const imbalancedCount = verifications.filter((result) => !result.balanced).length;
  if (imbalancedCount > 0) {
    throw new Error(`${imbalancedCount} sampled ledgers were imbalanced`);
  }

  console.log(JSON.stringify({
    apiBase,
    orderCount,
    uniqueOrders: uniqueIds.size,
    durationMs,
    targetMs,
    withinTarget: durationMs <= targetMs,
    sampledLedgerChecks: sampleIds.length,
    imbalancedCount,
  }, null, 2));

  if (durationMs > targetMs) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
