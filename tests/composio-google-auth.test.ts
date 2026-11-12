import { test } from 'node:test';
import assert from 'node:assert/strict';

// Run the real routes and SDK serializer with an in-memory DB and no external requests.
test('Google callback proxies as the stored provisional connection owner before signing in an existing user', async (t) => {
  const settings = {
    HQ_VM: '1',
    HQ_LOCAL: '0',
    SESSION_SECRET: 'google-auth-test-only',
    COMPOSIO_API_KEY: 'google-auth-test-only-not-a-real-key',
    DB_PATH: ':memory:',
    APP_URL: 'http://localhost:5173',
    SERVER_URL: 'http://localhost:8787',
    TELEMETRY_DISABLED: 'true',
    NODE_ENV: 'test',
  };
  const saved = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let expectedOwner: string | undefined;
  const proxyRequests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://backend.composio.dev');
    assert.match(url.pathname, /\/tools\/execute\/proxy$/);
    assert.equal(request.method, 'POST');
    const body = await request.json() as Record<string, unknown>;
    proxyRequests.push(body);
    if (!body.user_id) {
      return Response.json({ error: { message: '2FA is enabled for this project: user_id is required with connected_account_id.', slug: 'ExternalProxy_UserIdRequired' } }, { status: 400 });
    }
    if (body.user_id !== expectedOwner) {
      return Response.json({ error: { message: 'Connected account owner mismatch' } }, { status: 403 });
    }
    return Response.json({ status: 200, headers: {}, data: { emailAddress: 'returning@example.test' } });
  });

  const { composio } = await import('../server/src/composio.js');
  const { db, now } = await import('../server/src/db.js');
  const { api } = await import('../server/src/routes.js');
  const { userFromCookieHeader } = await import('../server/src/lib/auth.js');
  t.after(() => db.close());
  // An existing app identity must not replace the owner used to create this connection.
  const existingUserId = 'usr_existing_member';
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)')
    .run(existingUserId, 'returning@example.test', 'Returning User', now());
  const connectedAccountId = 'ca_google_login';
  let callbackUrl = '';
  const create = t.mock.method(composio, 'create', async (owner: string) => {
    expectedOwner = owner;
    return {
      authorize: async (toolkit: string, options: { callbackUrl: string }) => {
        assert.equal(toolkit, 'gmail');
        callbackUrl = options.callbackUrl;
        return { id: connectedAccountId, redirectUrl: 'https://connect.example.invalid/google' };
      },
    } as never;
  });
  const deleted = t.mock.method(composio.connectedAccounts, 'delete', async () => ({} as never));
  // The unfixed callback reports the synthetic 2FA error; do not dump SDK requests or headers.
  t.mock.method(console, 'error', () => {});

  const start = await api.request('/auth/google/start');
  assert.equal(start.status, 302);
  assert.equal(create.mock.callCount(), 1);
  const callback = new URL(callbackUrl);
  const attemptId = callback.searchParams.get('attempt');
  assert.ok(attemptId);
  const attempt = db.prepare('SELECT provisional_user_id,connected_account_id FROM login_attempts WHERE id=?')
    .get(attemptId) as { provisional_user_id: string; connected_account_id: string };
  assert.equal(attempt.provisional_user_id, expectedOwner);
  assert.notEqual(attempt.provisional_user_id, existingUserId);
  assert.equal(attempt.connected_account_id, connectedAccountId);

  callback.searchParams.set('connected_account_id', connectedAccountId);
  // Callback query parameters are not a trusted source of the Composio owner.
  callback.searchParams.set('user_id', existingUserId);
  const response = await api.request(callback.pathname.replace(/^\/api/, '') + callback.search);

  assert.equal(proxyRequests.length, 1);
  assert.equal(proxyRequests[0].user_id, attempt.provisional_user_id,
    '2FA proxy must use the exact owner persisted when Google sign-in started');
  assert.equal(proxyRequests[0].connected_account_id, connectedAccountId);
  assert.equal(proxyRequests[0].endpoint, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
  assert.equal(proxyRequests[0].method, 'GET');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `${settings.APP_URL}/`);
  const user = userFromCookieHeader(response.headers.get('set-cookie') ?? undefined);
  assert.equal(user?.id, existingUserId);
  assert.equal(deleted.mock.callCount(), 1);
  assert.equal(deleted.mock.calls[0].arguments[0], connectedAccountId);
  assert.equal(db.prepare('SELECT id FROM login_attempts WHERE id=?').get(attemptId), undefined);
});
