import { describe, expect, it } from 'vitest';
import {
  decryptBytes,
  decryptJson,
  encryptBytes,
  encryptJson,
  generateIdentity,
  generateRoomKey,
  openSealedRoomKey,
  sealRoomKey,
  signText,
  verifyTextSignature
} from '../src/shared/crypto.js';

describe('cryptographic protocol', () => {
  it('signs and verifies device challenges', async () => {
    const identity = await generateIdentity();
    const challenge = 'challenge-123';
    const signature = await signText(challenge, identity.signPrivateKey);
    await expect(verifyTextSignature(challenge, signature, identity.signPublicKey)).resolves.toBe(true);
    await expect(verifyTextSignature(`${challenge}-tampered`, signature, identity.signPublicKey)).resolves.toBe(false);
  });

  it('seals the room key to one device', async () => {
    const recipient = await generateIdentity();
    const other = await generateIdentity();
    const roomKey = await generateRoomKey();
    const sealed = await sealRoomKey(roomKey, recipient.boxPublicKey);
    await expect(openSealedRoomKey(sealed, recipient.boxPublicKey, recipient.boxPrivateKey)).resolves.toBe(roomKey);
    await expect(openSealedRoomKey(sealed, other.boxPublicKey, other.boxPrivateKey)).rejects.toThrow();
  });

  it('encrypts JSON and rejects modified ciphertext', async () => {
    const roomKey = await generateRoomKey();
    const envelope = await encryptJson(roomKey, { text: 'private message', count: 3 }, 'message:test');
    await expect(decryptJson(roomKey, envelope, 'message:test')).resolves.toEqual({ text: 'private message', count: 3 });
    await expect(decryptJson(roomKey, envelope, 'message:other')).rejects.toThrow('metadata');
    const replacement = envelope.ciphertext.endsWith('A') ? 'B' : 'A';
    const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}${replacement}` };
    await expect(decryptJson(roomKey, tampered)).rejects.toThrow();
  });

  it('encrypts arbitrary binary files', async () => {
    const roomKey = await generateRoomKey();
    const original = crypto.getRandomValues(new Uint8Array(32_768));
    const encrypted = await encryptBytes(roomKey, original, 'asset:test');
    expect(encrypted).not.toEqual(original);
    await expect(decryptBytes(roomKey, encrypted, 'asset:test')).resolves.toEqual(original);
    await expect(decryptBytes(roomKey, encrypted, 'asset:wrong')).rejects.toThrow();
  });
});
