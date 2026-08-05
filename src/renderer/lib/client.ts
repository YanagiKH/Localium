import { signText } from '../../shared/crypto.js';
import { PROTOCOL_VERSION } from '../../shared/constants.js';
import type {
  AuthenticatedSnapshot,
  ClientMessage,
  DeviceIdentity,
  ServerMessage
} from '../../shared/types.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: number;
}

type EventListener = (payload: unknown) => void;

function httpBase(endpoint: string): string {
  const url = new URL(endpoint);
  url.protocol = 'https:';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/u, '');
}

export class LocaliumClient {
  private socket: WebSocket | null = null;
  private hello: Extract<ServerMessage, { type: 'hello' }> | null = null;
  private helloWaiters: Array<(hello: Extract<ServerMessage, { type: 'hello' }>) => void> = [];
  private requests = new Map<string, PendingRequest>();
  private listeners = new Map<string, Set<EventListener>>();
  snapshot: AuthenticatedSnapshot | null = null;

  constructor(
    readonly endpoint: string,
    readonly identity: DeviceIdentity
  ) {}

  async open(): Promise<Extract<ServerMessage, { type: 'hello' }>> {
    if (this.socket?.readyState === WebSocket.OPEN && this.hello) return this.hello;
    this.socket = new WebSocket(this.endpoint);
    this.socket.addEventListener('message', (event) => this.onMessage(event.data));
    this.socket.addEventListener('close', () => this.rejectAll(new Error('Connection closed.')));
    this.socket.addEventListener('error', () => this.emit('connection.error', null));
    return new Promise((resolve, reject) => {
      const waiter = (hello: Extract<ServerMessage, { type: 'hello' }>) => {
        window.clearTimeout(timeout);
        if (hello.protocolVersion !== PROTOCOL_VERSION) {
          this.socket?.close(1002, 'Protocol version mismatch');
          reject(new Error(`Unsupported server protocol version: ${hello.protocolVersion}.`));
          return;
        }
        resolve(hello);
      };
      const timeout = window.setTimeout(() => {
        const index = this.helloWaiters.indexOf(waiter);
        if (index >= 0) this.helloWaiters.splice(index, 1);
        this.socket?.close();
        reject(new Error('Server connection timed out.'));
      }, 12_000);
      this.helloWaiters.push(waiter);
    });
  }

  async authenticate(): Promise<AuthenticatedSnapshot> {
    const hello = await this.open();
    const signature = await signText(hello.challenge, this.identity.signPrivateKey);
    const snapshot = await new Promise<AuthenticatedSnapshot>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Authentication timed out.'));
      }, 15_000);
      const onAuth = (payload: unknown) => {
        cleanup();
        resolve(payload as AuthenticatedSnapshot);
      };
      const onError = (payload: unknown) => {
        cleanup();
        reject(new Error(String(payload)));
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        this.off('auth.ok', onAuth);
        this.off('protocol.error', onError);
      };
      this.on('auth.ok', onAuth);
      this.on('protocol.error', onError);
      this.send({ type: 'auth', deviceId: this.identity.deviceId, signature });
    });
    this.snapshot = snapshot;
    return snapshot;
  }

  async requestJoin(inviteCode: string, displayName: string): Promise<string> {
    const hello = await this.open();
    const signature = await signText(hello.challenge, this.identity.signPrivateKey);
    return new Promise<string>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Join request timed out.'));
      }, 15_000);
      const onPending = (payload: unknown) => {
        cleanup();
        resolve(String(payload));
      };
      const onApproved = (payload: unknown) => {
        cleanup();
        resolve(String((payload as { pendingId?: unknown }).pendingId ?? 'approved'));
      };
      const onError = (payload: unknown) => {
        cleanup();
        reject(new Error(String(payload)));
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        this.off('join.pending', onPending);
        this.off('join.approved', onApproved);
        this.off('protocol.error', onError);
      };
      this.on('join.pending', onPending);
      this.on('join.approved', onApproved);
      this.on('protocol.error', onError);
      this.send({
        type: 'join.request',
        inviteCode,
        displayName,
        deviceId: this.identity.deviceId,
        signPublicKey: this.identity.signPublicKey,
        boxPublicKey: this.identity.boxPublicKey,
        signature
      });
    });
  }

  async request<T>(message: { type: string; requestId?: string; [key: string]: unknown }): Promise<T> {
    const requestId = message.requestId ?? crypto.randomUUID();
    const complete = { ...message, requestId } as ClientMessage;
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.requests.delete(requestId);
        reject(new Error('Server request timed out.'));
      }, 15_000);
      this.requests.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });
      this.send(complete);
    });
  }

  on(event: string, listener: EventListener): () => void {
    const set = this.listeners.get(event) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(event, set);
    return () => this.off(event, listener);
  }

  off(event: string, listener: EventListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.hello = null;
    this.snapshot = null;
  }

  async uploadAsset(kind: 'attachment' | 'sticker' | 'background' | 'avatar', bytes: Uint8Array): Promise<{ assetId: string; byteLength: number }> {
    if (!this.snapshot) throw new Error('Not authenticated.');
    const response = await fetch(`${httpBase(this.endpoint)}/api/assets?kind=${kind}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.snapshot.sessionToken}`,
        'content-type': 'application/octet-stream'
      },
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    });
    const result = (await response.json()) as { assetId?: string; byteLength?: number; error?: string };
    if (!response.ok || !result.assetId) throw new Error(result.error ?? 'Asset upload failed.');
    return { assetId: result.assetId, byteLength: result.byteLength ?? bytes.length };
  }

  async downloadAsset(assetId: string): Promise<Uint8Array> {
    if (!this.snapshot) throw new Error('Not authenticated.');
    const response = await fetch(`${httpBase(this.endpoint)}/api/assets/${encodeURIComponent(assetId)}`, {
      headers: { authorization: `Bearer ${this.snapshot.sessionToken}` }
    });
    if (!response.ok) {
      const result = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(result?.error ?? 'Asset download failed.');
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  private send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Not connected.');
    this.socket.send(JSON.stringify(message));
  }

  private onMessage(raw: unknown): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(String(raw)) as ServerMessage;
    } catch {
      this.emit('protocol.error', 'Server returned invalid JSON.');
      return;
    }
    if (message.type === 'hello') {
      this.hello = message;
      for (const waiter of this.helloWaiters.splice(0)) waiter(message);
      this.emit('hello', message);
      return;
    }
    if (message.type === 'auth.ok') {
      this.snapshot = message.snapshot;
      this.emit('auth.ok', message.snapshot);
      return;
    }
    if (message.type === 'join.pending') {
      this.emit('join.pending', message.pendingId);
      return;
    }
    if (message.type === 'join.approved') {
      this.emit('join.approved', message);
      return;
    }
    if (message.type === 'join.rejected') {
      this.emit('join.rejected', message.pendingId);
      return;
    }
    if (message.type === 'event') {
      this.emit(message.event, message.payload);
      return;
    }
    if (message.type === 'response') {
      const pending = this.requests.get(message.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      this.requests.delete(message.requestId);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(new Error(message.error));
      return;
    }
    if (message.type === 'error') this.emit('protocol.error', message.error);
  }

  private emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.requests.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.requests.clear();
    this.emit('connection.closed', null);
  }
}
