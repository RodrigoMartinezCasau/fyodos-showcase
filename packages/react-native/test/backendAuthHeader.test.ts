/**
 * Who the backend believes is asking, from a phone.
 *
 * A company orb reaches the company's connected services only for a PROVEN
 * member. The project API key cannot be that proof: it ships inside the app
 * bundle, which anyone can unpack. So an employee app has to be able to send
 * the person's session token.
 *
 * The contract pinned here is that the option is ADDITIVE: a client that does
 * not pass `getAuthToken` sends exactly the headers it always sent. A
 * customer-facing app has no signed-in employee, and attaching a stray
 * Authorization header to a shopper's turn would be a new way to leak a token.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFiodosBackendClient } from '../src/api/backendClient';

type Captured = { url: string; headers: Record<string, string> };

/** Installs a fake fetch and returns what the client sent. */
function captureTurnHeaders(
  options: Parameters<typeof createFiodosBackendClient>[0],
): Promise<Captured> {
  const original = globalThis.fetch;
  let captured: Captured | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = {
      url: String(url),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({ reply: 'ok' }),
    } as unknown as Response;
  }) as typeof fetch;

  const client = createFiodosBackendClient(options);
  return (async () => {
    try {
      await client.sendTurn({ message: 'hola', language: 'es' } as never);
    } catch {
      // The fake response is minimal; only the request matters here.
    } finally {
      globalThis.fetch = original;
    }
    assert.ok(captured, 'the client never issued a request');
    return captured as Captured;
  })();
}

describe('turn auth header', () => {
  it('sends no Authorization header by default', async () => {
    const sent = await captureTurnHeaders({
      baseUrl: 'https://api.test',
      apiKey: 'key-1',
      getUserId: () => 'anon-1',
    });
    assert.equal(sent.headers.Authorization, undefined);
    // …and still sends what it always did.
    assert.equal(sent.headers['x-api-key'], 'key-1');
    assert.equal(sent.headers['x-user-id'], 'anon-1');
  });

  it('sends the bearer token when the host provides one', async () => {
    const sent = await captureTurnHeaders({
      baseUrl: 'https://api.test',
      apiKey: 'key-1',
      getUserId: () => 'member:dev-1:iorb:conv-1',
      getAuthToken: () => 'tok-abc',
    });
    assert.equal(sent.headers.Authorization, 'Bearer tok-abc');
    // The member ref still travels: it partitions memory and attributes write
    // proposals. It just stopped being the proof of identity.
    assert.equal(sent.headers['x-user-id'], 'member:dev-1:iorb:conv-1');
  });

  it('omits the header when the token getter returns nothing', async () => {
    // Signed out mid-session, or a host that wires the option but has no token
    // yet: send no header rather than `Bearer null`. FiodosExpoAgent always
    // wires the getter, so this is the ordinary case for a public app.
    for (const token of [null, undefined, '']) {
      const sent = await captureTurnHeaders({
        baseUrl: 'https://api.test',
        apiKey: 'key-1',
        getAuthToken: () => token,
      });
      assert.equal(sent.headers.Authorization, undefined, `token=${String(token)}`);
    }
  });

  it('reads the token on every request, so a re-minted one is picked up', async () => {
    // The app stays mounted for days while the session is refreshed, so a value
    // captured at mount time would eventually be stale.
    let current = 'tok-1';
    const options = {
      baseUrl: 'https://api.test',
      apiKey: 'key-1',
      getAuthToken: () => current,
    };
    const first = await captureTurnHeaders(options);
    assert.equal(first.headers.Authorization, 'Bearer tok-1');
    current = 'tok-2';
    const second = await captureTurnHeaders(options);
    assert.equal(second.headers.Authorization, 'Bearer tok-2');
  });
});
