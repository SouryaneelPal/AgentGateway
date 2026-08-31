/**
 * The API client's auth-header behaviour.
 *
 * This is the one piece of client logic worth pinning: every /v1/merchant/* call must
 * carry the merchant key, and a dropped header does not fail loudly — it returns a 401
 * that looks indistinguishable from a bad key, sending whoever debugs it after the wrong
 * problem. So the header construction is tested directly.
 */

import { describe, expect, it } from 'vitest';
import { authHeaders } from '../lib/api-client';

describe('authHeaders', () => {
  it('attaches the key as a bearer token', () => {
    expect(authHeaders('agk_test123')).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer agk_test123',
    });
  });

  it('omits the header entirely when there is no key, rather than sending "Bearer null"', () => {
    // Sending `Bearer null` would be authenticated-looking garbage; the gateway would
    // reject it as an invalid key rather than as a missing one, which is a worse error.
    expect(authHeaders(null)).toEqual({ 'content-type': 'application/json' });
    expect(authHeaders(null)).not.toHaveProperty('authorization');
  });

  it('omits the header for an empty-string key', () => {
    expect(authHeaders('')).not.toHaveProperty('authorization');
  });

  it('always sets a JSON content type, key or not', () => {
    expect(authHeaders('agk_x')['content-type']).toBe('application/json');
    expect(authHeaders(null)['content-type']).toBe('application/json');
  });

  it('does not mangle a key containing base64url characters', () => {
    const key = 'agk_aB3-_xY9zQ';
    expect(authHeaders(key).authorization).toBe(`Bearer ${key}`);
  });
});
