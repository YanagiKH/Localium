import { describe, expect, it } from 'vitest';
import { decodeInvite, encodeInvite } from '../src/shared/invite.js';
import type { InvitePayload } from '../src/shared/types.js';

const invite: InvitePayload = {
  version: 1,
  endpoint: 'wss://192.168.1.10:9473/socket',
  serverId: '3ec9ff56-5fd9-42d6-8875-799d2ad1d82d',
  serverName: 'Localium Test',
  secret: '3ec9ff56-5fd9-42d6-8875-799d2ad1d82d.secret-value-1234567890',
  fingerprint: 'AB'.repeat(32),
  expiresAt: new Date(Date.now() + 60_000).toISOString()
};

describe('invitation codes', () => {
  it('round-trips a pinned server invitation', () => {
    const code = encodeInvite(invite);
    expect(code.startsWith('LOCALIUM1.')).toBe(true);
    expect(decodeInvite(code)).toEqual(invite);
  });

  it('rejects expired invitations', () => {
    const code = encodeInvite({ ...invite, expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect(() => decodeInvite(code)).toThrow('expired');
  });

  it('rejects non-TLS endpoints and malformed codes', () => {
    expect(() => encodeInvite({ ...invite, endpoint: 'ws://127.0.0.1:9473/socket' })).toThrow();
    expect(() => decodeInvite('not-an-invite')).toThrow();
  });
});
