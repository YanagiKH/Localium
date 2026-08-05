import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { LocaliumServer } from '../src/main/server.js';
import {
  decryptJson,
  encryptJson,
  generateIdentity,
  generateRoomKey,
  openSealedRoomKey,
  sealRoomKey,
  signText
} from '../src/shared/crypto.js';
import { decodeInvite } from '../src/shared/invite.js';
import type { DecryptedChatPayload, MessageRecord, PendingJoinRecord, ServerMessage } from '../src/shared/types.js';

const servers: LocaliumServer[] = [];
const directories: string[] = [];

class SocketHarness {
  private readonly queued: ServerMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: ServerMessage) => boolean;
    resolve: (message: ServerMessage) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString('utf8')) as ServerMessage;
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      } else {
        this.queued.push(message);
      }
    });
    socket.on('error', (error) => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  next(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
    const index = this.queued.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.queued.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const waiterIndex = this.waiters.indexOf(waiter);
          if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
          reject(new Error('Timed out waiting for socket message.'));
        }, 10_000)
      };
      this.waiters.push(waiter);
    });
  }

  type<T extends ServerMessage['type']>(type: T): Promise<Extract<ServerMessage, { type: T }>> {
    return this.next((message) => message.type === type) as Promise<Extract<ServerMessage, { type: T }>>;
  }

  response(requestId: string): Promise<Extract<ServerMessage, { type: 'response' }>> {
    return this.next((message) => message.type === 'response' && message.requestId === requestId) as Promise<
      Extract<ServerMessage, { type: 'response' }>
    >;
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTestServer() {
  const directory = await mkdtemp(path.join(tmpdir(), 'localium-server-'));
  directories.push(directory);
  const ownerIdentity = await generateIdentity();
  const roomKey = await generateRoomKey();
  const encryptedRoomKey = await sealRoomKey(roomKey, ownerIdentity.boxPublicKey);
  const server = new LocaliumServer({
    dataDir: directory,
    port: 0,
    bindHost: '127.0.0.1',
    advertisedHost: '127.0.0.1',
    bootstrap: {
      serverId: '04166523-e1a3-45d8-b212-df83ebc03079',
      serverName: 'Integration Test',
      owner: {
        deviceId: ownerIdentity.deviceId,
        displayName: 'Owner',
        signPublicKey: ownerIdentity.signPublicKey,
        boxPublicKey: ownerIdentity.boxPublicKey,
        roleIds: ['owner'],
        encryptedRoomKey
      }
    }
  });
  servers.push(server);
  return { server, info: await server.start(), ownerIdentity, roomKey };
}

async function authenticate(harness: SocketHarness, identity: Awaited<ReturnType<typeof generateIdentity>>) {
  const hello = await harness.type('hello');
  harness.send({
    type: 'auth',
    deviceId: identity.deviceId,
    signature: await signText(hello.challenge, identity.signPrivateKey)
  });
  return harness.type('auth.ok');
}

describe('Localium server', () => {
  it('authenticates the owner and creates a pinned temporary invitation', async () => {
    const { info, ownerIdentity } = await createTestServer();
    const owner = new SocketHarness(new WebSocket(info.endpoint, { rejectUnauthorized: false }));
    await authenticate(owner, ownerIdentity);

    const requestId = crypto.randomUUID();
    owner.send({ type: 'invite.create', requestId, permanent: false, maxUses: 1 });
    const response = await owner.response(requestId);
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error);
    const data = response.data as { code: string };
    const invite = decodeInvite(data.code);
    expect(invite.serverId).toBe(info.serverId);
    expect(invite.fingerprint).toBe(info.fingerprint);
    expect(invite.expiresAt).not.toBeNull();
    owner.socket.close();
  });

  it('requires approval, delivers a sealed room key, and accepts bound encrypted messages', async () => {
    const { info, ownerIdentity, roomKey } = await createTestServer();
    const owner = new SocketHarness(new WebSocket(info.endpoint, { rejectUnauthorized: false }));
    await authenticate(owner, ownerIdentity);

    const inviteRequestId = crypto.randomUUID();
    owner.send({ type: 'invite.create', requestId: inviteRequestId, permanent: false, maxUses: 1 });
    const inviteResponse = await owner.response(inviteRequestId);
    if (!inviteResponse.ok) throw new Error(inviteResponse.error);
    const inviteCode = (inviteResponse.data as { code: string }).code;

    const memberIdentity = await generateIdentity();
    const member = new SocketHarness(new WebSocket(info.endpoint, { rejectUnauthorized: false }));
    const memberHello = await member.type('hello');
    member.send({
      type: 'join.request',
      inviteCode,
      displayName: 'Approved Member',
      deviceId: memberIdentity.deviceId,
      signPublicKey: memberIdentity.signPublicKey,
      boxPublicKey: memberIdentity.boxPublicKey,
      signature: await signText(memberHello.challenge, memberIdentity.signPrivateKey)
    });
    const pendingMessage = await member.type('join.pending');
    const pendingEvent = await owner.next(
      (message) => message.type === 'event' && message.event === 'pending.created'
    );
    if (pendingEvent.type !== 'event') throw new Error('Expected pending event.');
    const pending = pendingEvent.payload as PendingJoinRecord;
    expect(pending.id).toBe(pendingMessage.pendingId);

    const sealedForMember = await sealRoomKey(roomKey, memberIdentity.boxPublicKey);
    const approvalRequestId = crypto.randomUUID();
    owner.send({
      type: 'pending.approve',
      requestId: approvalRequestId,
      pendingId: pending.id,
      encryptedRoomKey: sealedForMember,
      roleIds: ['member']
    });
    const approved = await member.type('join.approved');
    await expect(
      openSealedRoomKey(approved.encryptedRoomKey, memberIdentity.boxPublicKey, memberIdentity.boxPrivateKey)
    ).resolves.toBe(roomKey);
    const approvalResponse = await owner.response(approvalRequestId);
    expect(approvalResponse.ok).toBe(true);

    // Approval recovery must still work after this one-use invitation reached its limit.
    const recoveringMember = new SocketHarness(new WebSocket(info.endpoint, { rejectUnauthorized: false }));
    const recoveryHello = await recoveringMember.type('hello');
    recoveringMember.send({
      type: 'join.request',
      inviteCode,
      displayName: 'Approved Member',
      deviceId: memberIdentity.deviceId,
      signPublicKey: memberIdentity.signPublicKey,
      boxPublicKey: memberIdentity.boxPublicKey,
      signature: await signText(recoveryHello.challenge, memberIdentity.signPrivateKey)
    });
    const recoveredApproval = await recoveringMember.type('join.approved');
    await expect(
      openSealedRoomKey(recoveredApproval.encryptedRoomKey, memberIdentity.boxPublicKey, memberIdentity.boxPrivateKey)
    ).resolves.toBe(roomKey);
    recoveringMember.socket.close();

    member.send({
      type: 'auth',
      deviceId: memberIdentity.deviceId,
      signature: await signText(memberHello.challenge, memberIdentity.signPrivateKey)
    });
    const memberAuth = await member.type('auth.ok');
    expect(memberAuth.snapshot.self.displayName).toBe('Approved Member');

    // A delegated member manager cannot assign a role containing permissions they do not own.
    const roleRequestId = crypto.randomUUID();
    owner.send({
      type: 'role.create',
      requestId: roleRequestId,
      name: 'Member Manager',
      color: '#4f8cff',
      permissions: ['manage_members', 'send_messages', 'send_files']
    });
    const roleResponse = await owner.response(roleRequestId);
    expect(roleResponse.ok).toBe(true);
    if (!roleResponse.ok) throw new Error(roleResponse.error);
    const delegatedRole = roleResponse.data as { id: string };

    const assignRequestId = crypto.randomUUID();
    owner.send({
      type: 'member.update',
      requestId: assignRequestId,
      deviceId: memberIdentity.deviceId,
      roleIds: [delegatedRole.id]
    });
    expect((await owner.response(assignRequestId)).ok).toBe(true);

    const escalationRequestId = crypto.randomUUID();
    member.send({
      type: 'member.update',
      requestId: escalationRequestId,
      deviceId: memberIdentity.deviceId,
      roleIds: ['administrator']
    });
    const escalationResponse = await member.response(escalationRequestId);
    expect(escalationResponse.ok).toBe(false);
    if (escalationResponse.ok) throw new Error('Privilege escalation was unexpectedly accepted.');
    expect(escalationResponse.error).toContain('Cannot delegate permission');

    const invalidMessageId = crypto.randomUUID();
    const invalidEnvelope = await encryptJson<DecryptedChatPayload>(roomKey, { kind: 'text', text: 'invalid' }, 'message:wrong');
    const invalidRequestId = crypto.randomUUID();
    member.send({
      type: 'message.send',
      requestId: invalidRequestId,
      messageId: invalidMessageId,
      envelope: invalidEnvelope
    });
    const invalidResponse = await member.response(invalidRequestId);
    expect(invalidResponse.ok).toBe(false);

    const messageId = crypto.randomUUID();
    const envelope = await encryptJson<DecryptedChatPayload>(roomKey, { kind: 'text', text: 'private hello' }, `message:${messageId}`);
    const messageRequestId = crypto.randomUUID();
    member.send({ type: 'message.send', requestId: messageRequestId, messageId, envelope });
    const ownerEvent = await owner.next(
      (message) => message.type === 'event' && message.event === 'message.created'
    );
    if (ownerEvent.type !== 'event') throw new Error('Expected message event.');
    const storedMessage = ownerEvent.payload as MessageRecord;
    expect(storedMessage.senderDeviceId).toBe(memberIdentity.deviceId);
    await expect(
      decryptJson<DecryptedChatPayload>(roomKey, storedMessage.envelope, `message:${storedMessage.id}`)
    ).resolves.toEqual({ kind: 'text', text: 'private hello' });
    const messageResponse = await member.response(messageRequestId);
    expect(messageResponse.ok).toBe(true);

    owner.socket.close();
    member.socket.close();
  });
});
