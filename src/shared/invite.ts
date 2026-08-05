import { z } from 'zod';
import type { InvitePayload } from './types.js';

const PREFIX = 'LOCALIUM1.';

const inviteSchema = z.object({
  version: z.literal(1),
  endpoint: z.string().url().refine((value: string) => value.startsWith('wss://'), 'Invite endpoint must use wss://'),
  serverId: z.string().min(8).max(128),
  serverName: z.string().min(1).max(80),
  secret: z.string().min(16).max(256),
  fingerprint: z.string().min(32).max(256),
  expiresAt: z.string().datetime().nullable()
}).strict();

function encodeBase64Url(text: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(text, 'utf8').toString('base64url');
  }
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'base64url').toString('utf8');
  }
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeInvite(payload: InvitePayload): string {
  const parsed = inviteSchema.parse(payload);
  return PREFIX + encodeBase64Url(JSON.stringify(parsed));
}

export function decodeInvite(code: string): InvitePayload {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX)) {
    throw new Error('This is not a Localium invitation code.');
  }
  let value: unknown;
  try {
    value = JSON.parse(decodeBase64Url(trimmed.slice(PREFIX.length)));
  } catch {
    throw new Error('The invitation code is malformed.');
  }
  const parsed = inviteSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('The invitation code is invalid.');
  }
  if (parsed.data.expiresAt && Date.parse(parsed.data.expiresAt) <= Date.now()) {
    throw new Error('The invitation code has expired.');
  }
  return parsed.data;
}
