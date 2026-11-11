import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler } from '../supabase/functions/account-erasure/handler.mjs';

const testWorkerSecret = 'a'.repeat(64);
const config = {
  supabaseUrl: 'https://project.example.invalid', serviceKey: 'sb_secret_test',
  projectId: 'proj123', revenueCatKey: 'sk_test',
};
const job = {
  id: '11111111-1111-4111-8111-111111111111',
  customer_id: '22222222-2222-4222-8222-222222222222',
  lease_token: '33333333-3333-4333-8333-333333333333',
  project_id: config.projectId,
};
const response = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), {status, headers});

function fixture(options = {}) {
  const calls = [];
  const reads = [...(options.reads || [200, 404])];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname, body = init.body && JSON.parse(init.body);
    calls.push({url, path, method: init.method || 'GET', body});
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    if (url.includes('/rest/v1/rpc/')) {
      assert.equal(init.headers.apikey, config.serviceKey);
      assert.equal(init.headers.Authorization, undefined);
      if (path.endsWith('/consume_account_erasure_invocation')) {
        assert.match(body.p_hash, /^[a-f0-9]{64}$/);
        return response(200, options.consume ?? true);
      }
      if (path.endsWith('/claim_account_erasures')) return response(200, options.jobs ?? [job]);
      if (path.endsWith('/complete_account_erasure')) return response(200, options.complete ?? true);
      if (path.endsWith('/defer_account_erasure')) return response(200, true);
    } else {
      assert.equal(init.headers.Authorization, 'Bearer ' + config.revenueCatKey);
      if (url.endsWith('/customers?limit=1')) return response(options.projectStatus || 200, {items: []});
      assert.equal(path, '/v2/projects/proj123/customers/' + encodeURIComponent((options.jobs?.[0] || job).customer_id));
      if (init.method === 'DELETE') return response(options.deleteStatus || 202);
      if (options.throwRead) throw new Error('simulated network timeout');
      return response(reads.shift(), {}, options.readHeaders);
    }
    throw new Error('Unexpected test request');
  };
  const invoke = async (header = 'Bearer ' + testWorkerSecret, method = 'POST') => {
    const result = await createHandler(config, fetch)(new Request('https://worker.example.invalid', {
      method, headers: {authorization: header},
    }));
    return {status: result.status, body: await result.json()};
  };
  return {calls, invoke};
}

test('erasure worker rejects unauthorized requests before contacting providers', async () => {
  const f = fixture();
  assert.equal((await f.invoke('Bearer invalid')).status, 401);
  assert.equal((await f.invoke(undefined, 'GET')).status, 405);
  assert.equal(f.calls.length, 0);
});

test('erasure worker verifies the project before claiming durable requests', async () => {
  const f = fixture({projectStatus: 404});
  assert.equal((await f.invoke()).status, 503);
  assert.equal(f.calls.length, 2);
  const empty = fixture({jobs: []});
  assert.deepEqual((await empty.invoke()).body, {claimed: 0, completed: 0, deferred: 0, errors: 0});
});

test('unknown, expired or reused invocation tokens cannot reach RevenueCat or claim jobs', async () => {
  const f = fixture({consume: false});
  assert.equal((await f.invoke()).status, 401);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].path.endsWith('/consume_account_erasure_invocation'));
});

test('erasure completes only after a v2 lookup confirms the customer is absent', async () => {
  const f = fixture();
  assert.deepEqual((await f.invoke()).body, {claimed: 1, completed: 1, deferred: 0, errors: 0});
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
  assert.deepEqual(f.calls.at(-1).body, {p_id: job.id, p_lease_token: job.lease_token});
  assert.ok(f.calls.every(c => !c.url.includes('/v1/subscribers')));
  const absent = fixture({reads: [404]});
  assert.equal((await absent.invoke()).body.completed, 1);
  assert.equal(absent.calls.filter(c => c.method === 'DELETE').length, 0);
});

test('asynchronous deletion and rate limiting remain queued with bounded retries', async () => {
  const pending = fixture({reads: [200, 200]});
  assert.equal((await pending.invoke()).body.deferred, 1);
  assert.equal(pending.calls.at(-1).body.p_error_code, 'verification_pending');
  const limited = fixture({reads: [429], readHeaders: {'retry-after': '121'}});
  assert.equal((await limited.invoke()).body.deferred, 1);
  assert.equal(limited.calls.at(-1).body.p_error_code, 'rate_limited');
  assert.equal(limited.calls.at(-1).body.p_retry_after, 121);
});

test('server-queued anonymous test profiles use the same verified erasure flow', async () => {
  const customer_id = '$RCAnonymousID:' + 'a'.repeat(32);
  const f = fixture({jobs: [{...job, customer_id}]});
  assert.deepEqual((await f.invoke()).body, {claimed: 1, completed: 1, deferred: 0, errors: 0});
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.ok(f.calls.some(call => call.path.endsWith(encodeURIComponent(customer_id))));
});

test('unsupported server-queued identities are deferred without contacting a customer endpoint', async () => {
  const f = fixture({jobs: [{...job, customer_id: '../unexpected'}]});
  assert.deepEqual((await f.invoke()).body, {claimed: 1, completed: 0, deferred: 1, errors: 0});
  assert.equal(f.calls.at(-1).body.p_error_code, 'configuration');
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
});

test('project mismatches and expired leases cannot complete or target another project', async () => {
  const mismatch = fixture({jobs: [{...job, project_id: 'projOTHER'}]});
  assert.equal((await mismatch.invoke()).body.deferred, 1);
  assert.equal(mismatch.calls.at(-1).body.p_error_code, 'project_mismatch');
  assert.equal(mismatch.calls.filter(c => c.url.includes(job.customer_id)).length, 0);
  const stale = fixture({reads: [404], complete: false});
  assert.equal((await stale.invoke()).body.errors, 1);
});

test('network and authorization failures are retryable without exposing customer identifiers', async () => {
  for (const options of [{throwRead: true}, {reads: [403]}]) {
    const f = fixture(options);
    const result = await f.invoke();
    assert.equal(result.body.deferred, 1);
    assert.ok(!JSON.stringify(result.body).includes(job.customer_id));
    assert.ok(['temporary', 'auth'].includes(f.calls.at(-1).body.p_error_code));
  }
});
