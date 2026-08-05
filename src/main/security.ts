import { X509Certificate, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import selfsigned from 'selfsigned';

export interface TlsMaterial {
  key: string;
  cert: string;
  fingerprint: string;
}

export function normalizeFingerprint(value: string): string {
  return value.replaceAll(':', '').trim().toUpperCase();
}

export async function loadOrCreateTlsMaterial(dataDir: string): Promise<TlsMaterial> {
  const tlsDir = path.join(dataDir, 'tls');
  const keyPath = path.join(tlsDir, 'server-key.pem');
  const certPath = path.join(tlsDir, 'server-cert.pem');
  await mkdir(tlsDir, { recursive: true, mode: 0o700 });

  let key: string;
  let cert: string;
  try {
    [key, cert] = await Promise.all([readFile(keyPath, 'utf8'), readFile(certPath, 'utf8')]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const notAfterDate = new Date();
    notAfterDate.setUTCDate(notAfterDate.getUTCDate() + 825);
    const generated = await selfsigned.generate(
      [{ name: 'commonName', value: 'Localium private server' }],
      {
        algorithm: 'sha256',
        keyType: 'rsa',
        keySize: 3072,
        notAfterDate,
        extensions: [
          {
            name: 'subjectAltName',
            altNames: [
              { type: 2, value: 'localhost' },
              { type: 7, ip: '127.0.0.1' }
            ]
          }
        ]
      }
    );
    key = generated.private;
    cert = generated.cert;
    await Promise.all([
      writeFile(keyPath, key, { encoding: 'utf8', mode: 0o600 }),
      writeFile(certPath, cert, { encoding: 'utf8', mode: 0o600 })
    ]);
  }
  const fingerprint = normalizeFingerprint(new X509Certificate(cert).fingerprint256);
  return { key, cert, fingerprint };
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

export function constantTimeSecretEqual(leftHash: string, rightHash: string): boolean {
  const left = Buffer.from(leftHash);
  const right = Buffer.from(rightHash);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
