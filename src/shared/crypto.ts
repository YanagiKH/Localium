import sodium from 'libsodium-wrappers-sumo';
import type { DeviceIdentity, EncryptedEnvelope } from './types.js';

function toBase64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function fromBase64(value: string): Uint8Array {
  return sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export async function sodiumReady(): Promise<void> {
  await sodium.ready;
}

export async function deriveDeviceId(signPublicKey: string): Promise<string> {
  await sodiumReady();
  return toBase64(sodium.crypto_generichash(18, fromBase64(signPublicKey)));
}

export async function generateIdentity(): Promise<DeviceIdentity> {
  await sodiumReady();
  const sign = sodium.crypto_sign_keypair();
  const box = sodium.crypto_box_keypair();
  const deviceId = await deriveDeviceId(toBase64(sign.publicKey));
  return {
    deviceId,
    signPublicKey: toBase64(sign.publicKey),
    signPrivateKey: toBase64(sign.privateKey),
    boxPublicKey: toBase64(box.publicKey),
    boxPrivateKey: toBase64(box.privateKey)
  };
}

export async function generateRoomKey(): Promise<string> {
  await sodiumReady();
  return toBase64(sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES));
}

export async function signText(text: string, privateKey: string): Promise<string> {
  await sodiumReady();
  const signature = sodium.crypto_sign_detached(sodium.from_string(text), fromBase64(privateKey));
  return toBase64(signature);
}

export async function verifyTextSignature(text: string, signature: string, publicKey: string): Promise<boolean> {
  await sodiumReady();
  try {
    return sodium.crypto_sign_verify_detached(fromBase64(signature), sodium.from_string(text), fromBase64(publicKey));
  } catch {
    return false;
  }
}

export async function sealRoomKey(roomKey: string, recipientPublicKey: string): Promise<string> {
  await sodiumReady();
  return toBase64(sodium.crypto_box_seal(fromBase64(roomKey), fromBase64(recipientPublicKey)));
}

export async function openSealedRoomKey(
  encryptedRoomKey: string,
  recipientPublicKey: string,
  recipientPrivateKey: string
): Promise<string> {
  await sodiumReady();
  const opened = sodium.crypto_box_seal_open(
    fromBase64(encryptedRoomKey),
    fromBase64(recipientPublicKey),
    fromBase64(recipientPrivateKey)
  );
  if (!opened) {
    throw new Error('Unable to decrypt the server room key.');
  }
  return toBase64(opened);
}

export async function encryptJson<T>(roomKey: string, value: T, aadText: string): Promise<EncryptedEnvelope> {
  await sodiumReady();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const aad = sodium.from_string(aadText);
  const plaintext = sodium.from_string(JSON.stringify(value));
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    fromBase64(roomKey)
  );
  return {
    version: 1,
    nonce: toBase64(nonce),
    ciphertext: toBase64(ciphertext),
    aad: aadText
  };
}

export async function decryptJson<T>(
  roomKey: string,
  envelope: EncryptedEnvelope,
  expectedAad?: string
): Promise<T> {
  await sodiumReady();
  if (expectedAad !== undefined && envelope.aad !== expectedAad) {
    throw new Error('Encrypted message metadata does not match its record.');
  }
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    fromBase64(envelope.ciphertext),
    sodium.from_string(envelope.aad),
    fromBase64(envelope.nonce),
    fromBase64(roomKey)
  );
  return JSON.parse(sodium.to_string(plaintext)) as T;
}

export async function encryptBytes(roomKey: string, bytes: Uint8Array, aadText: string): Promise<Uint8Array> {
  await sodiumReady();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    bytes,
    sodium.from_string(aadText),
    null,
    nonce,
    fromBase64(roomKey)
  );
  const result = new Uint8Array(nonce.length + ciphertext.length);
  result.set(nonce, 0);
  result.set(ciphertext, nonce.length);
  return result;
}

export async function decryptBytes(roomKey: string, bytes: Uint8Array, aadText: string): Promise<Uint8Array> {
  await sodiumReady();
  const nonceLength = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (bytes.length <= nonceLength) {
    throw new Error('Encrypted asset is invalid.');
  }
  const nonce = bytes.slice(0, nonceLength);
  const ciphertext = bytes.slice(nonceLength);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    sodium.from_string(aadText),
    nonce,
    fromBase64(roomKey)
  );
}

export async function hashText(text: string): Promise<string> {
  await sodiumReady();
  return toBase64(sodium.crypto_generichash(32, sodium.from_string(text)));
}

export async function randomToken(bytes = 32): Promise<string> {
  await sodiumReady();
  return toBase64(sodium.randombytes_buf(bytes));
}
