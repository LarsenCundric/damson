import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalRegistry } from '../src/approvals.ts';

test('approve resolves to approved', async () => {
  const reg = new ApprovalRegistry();
  const { id, promise } = reg.request('push to main');
  setImmediate(() => reg.decide(id, 'approved'));
  const result = await promise;
  assert.equal(result, 'approved');
  assert.equal(reg.pendingCount(), 0);
});

test('deny resolves to denied', async () => {
  const reg = new ApprovalRegistry();
  const { id, promise } = reg.request('delete repo');
  setImmediate(() => reg.decide(id, 'denied'));
  const result = await promise;
  assert.equal(result, 'denied');
});

test('timeout resolves to timeout (fail-safe)', async () => {
  const reg = new ApprovalRegistry();
  const { promise } = reg.request('do thing', 100);
  const result = await promise;
  assert.equal(result, 'timeout');
});

test('decide on unknown id returns false', () => {
  const reg = new ApprovalRegistry();
  assert.equal(reg.decide('nonexistent', 'approved'), false);
});

test('cancel resolves to denied', async () => {
  const reg = new ApprovalRegistry();
  const { id, promise } = reg.request('something', 60_000);
  setImmediate(() => reg.cancel(id));
  const result = await promise;
  assert.equal(result, 'denied');
});

test('multiple pending approvals coexist', async () => {
  const reg = new ApprovalRegistry();
  const a = reg.request('first');
  const b = reg.request('second');
  assert.equal(reg.pendingCount(), 2);

  reg.decide(a.id, 'approved');
  reg.decide(b.id, 'denied');
  assert.equal(await a.promise, 'approved');
  assert.equal(await b.promise, 'denied');
  assert.equal(reg.pendingCount(), 0);
});

test('description over 500 chars is truncated internally', async () => {
  const reg = new ApprovalRegistry();
  const long = 'x'.repeat(2000);
  const { id, promise } = reg.request(long, 100);
  // Should not throw; just truncate internally
  const result = await promise;
  assert.equal(result, 'timeout');
});
