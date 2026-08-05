import { createServer, type Server as HttpsServer } from 'node:https';
import { createReadStream } from 'node:fs';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import {
  DEFAULT_INVITE_TTL_MS,
  MAX_ASSET_BYTES,
  MAX_MESSAGE_CIPHERTEXT_BYTES,
  PERMISSIONS,
  PROTOCOL_VERSION,
  SESSION_TTL_MS,
  SOCKET_RATE_LIMIT_PER_MINUTE,
  type Permission
} from '../shared/constants.js';
import { decodeInvite, encodeInvite } from '../shared/invite.js';
import { deriveDeviceId, verifyTextSignature } from '../shared/crypto.js';
import type {
  AssetRecord,
  AuthenticatedSnapshot,
  ClientMessage,
  CommandExecutionResult,
  EncryptedEnvelope,
  InviteRecord,
  MemberRecord,
  PersistedServerState,
  PublicServerSnapshot,
  RoleRecord,
  ServerMessage
} from '../shared/types.js';
import type { LocaliumServerInfo } from '../shared/desktop-api.js';
import { ServerStore, type BootstrapServerInput } from './store.js';
import { constantTimeSecretEqual, hashSecret, loadOrCreateTlsMaterial } from './security.js';
import { ModRegistry } from './mods.js';

const displayNameSchema = z.string().trim().min(1).max(64);
const serverNameSchema = z.string().trim().min(1).max(80);
const roleNameSchema = z.string().trim().min(1).max(40);
const stickerLabelSchema = z.string().trim().min(1).max(40);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/u);
const idSchema = z.string().min(1).max(128);
const keySchema = z.string().min(32).max(512);
const envelopeSchema = z.object({
  version: z.literal(1),
  nonce: z.string().min(16).max(128),
  ciphertext: z.string().min(1),
  aad: z.string().min(1).max(256)
}).strict();

export interface LocaliumServerConfig {
  dataDir: string;
  port: number;
  bindHost: string;
  advertisedHost: string;
  bootstrap?: BootstrapServerInput;
  debug?: boolean;
}

interface SessionRecord {
  token: string;
  deviceId: string;
  expiresAt: number;
}

interface SocketContext {
  socket: WebSocket;
  challenge: string;
  deviceId: string | null;
  pendingId: string | null;
  windowStartedAt: number;
  messageCount: number;
}

function now(): string {
  return new Date().toISOString();
}

function safeJsonParse(data: RawData): unknown {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('Socket message is too large.');
  return JSON.parse(text) as unknown;
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function publicInvite(record: InviteRecord): Omit<InviteRecord, 'secretHash'> {
  const { secretHash: _secretHash, ...rest } = record;
  return rest;
}

function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

function parsePermissions(value: unknown): Permission[] {
  if (!Array.isArray(value) || !value.every(isPermission)) throw new Error('Invalid permission list.');
  return [...new Set(value)];
}

function validateEncryptedEnvelope(value: unknown): EncryptedEnvelope {
  const parsed = envelopeSchema.parse(value);
  const estimatedBytes = Math.floor((parsed.ciphertext.length * 3) / 4);
  if (estimatedBytes > MAX_MESSAGE_CIPHERTEXT_BYTES) throw new Error('Encrypted message is too large.');
  return parsed;
}

function rolePermissions(state: PersistedServerState, member: MemberRecord): Set<Permission> {
  if (member.deviceId === state.ownerDeviceId) return new Set(PERMISSIONS);
  const permissions = new Set<Permission>();
  for (const roleId of member.roleIds) {
    const role = state.roles[roleId];
    if (!role) continue;
    for (const permission of role.permissions) permissions.add(permission);
  }
  return permissions;
}

function hasPermission(state: PersistedServerState, member: MemberRecord, permission: Permission): boolean {
  return rolePermissions(state, member).has(permission);
}

const DELEGATED_ADMIN_PERMISSIONS = new Set<Permission>(
  PERMISSIONS.filter((permission) => permission !== 'send_messages' && permission !== 'send_files')
);

function assertDelegablePermissions(
  state: PersistedServerState,
  actorDeviceId: string,
  permissions: Iterable<Permission>
): void {
  if (actorDeviceId === state.ownerDeviceId) return;
  const actor = getMemberOrThrow(state, actorDeviceId);
  const actorPermissions = rolePermissions(state, actor);
  for (const permission of permissions) {
    if (DELEGATED_ADMIN_PERMISSIONS.has(permission) && !actorPermissions.has(permission)) {
      throw new Error(`Cannot delegate permission: ${permission}`);
    }
  }
}

function assertDelegableRoles(state: PersistedServerState, actorDeviceId: string, roleIds: string[]): void {
  const combined = new Set<Permission>();
  for (const roleId of roleIds) {
    const role = state.roles[roleId];
    if (!role || roleId === 'owner') throw new Error('One or more roles are invalid.');
    for (const permission of role.permissions) combined.add(permission);
  }
  assertDelegablePermissions(state, actorDeviceId, combined);
}

function assertManageableMember(state: PersistedServerState, actorDeviceId: string, target: MemberRecord): void {
  if (actorDeviceId === state.ownerDeviceId) return;
  if (target.deviceId === state.ownerDeviceId) throw new Error('Only the owner can manage the owner account.');
  assertDelegablePermissions(state, actorDeviceId, rolePermissions(state, target));
}

function getMemberOrThrow(state: PersistedServerState, deviceId: string): MemberRecord {
  const member = state.members[deviceId];
  if (!member || member.revokedAt) throw new Error('Member access has been revoked.');
  return member;
}

function publicSnapshot(state: PersistedServerState): PublicServerSnapshot {
  return {
    serverId: state.serverId,
    ownerDeviceId: state.ownerDeviceId,
    settings: state.settings,
    members: Object.values(state.members).filter((member) => !member.revokedAt),
    roles: Object.values(state.roles),
    stickers: Object.values(state.stickers),
    messages: state.messages
  };
}

function responseError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: message }));
}

function setCors(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  response.setHeader('access-control-allow-headers', 'authorization,content-type');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
}

export class LocaliumServer {
  private readonly config: LocaliumServerConfig;
  private store!: ServerStore;
  private httpsServer: HttpsServer | null = null;
  private websocketServer: WebSocketServer | null = null;
  private sessions = new Map<string, SessionRecord>();
  private sockets = new Set<SocketContext>();
  private infoValue: LocaliumServerInfo | null = null;
  private mods: ModRegistry | null = null;

  constructor(config: LocaliumServerConfig) {
    this.config = config;
  }

  get info(): LocaliumServerInfo {
    if (!this.infoValue) throw new Error('Server is not running.');
    return this.infoValue;
  }

  async start(): Promise<LocaliumServerInfo> {
    if (this.httpsServer) return this.info;
    this.store = await ServerStore.openOrCreate(this.config.dataDir, this.config.bootstrap);
    this.mods = await ModRegistry.open(path.join(this.config.dataDir, 'mods'));
    const tls = await loadOrCreateTlsMaterial(this.config.dataDir);

    this.httpsServer = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
      void this.handleHttp(request, response).catch((error) => {
        this.log('error', 'HTTP request failed', { error: String(error) });
        if (!response.headersSent) responseError(response, 500, 'Internal server error.');
        else response.end();
      });
    });

    this.websocketServer = new WebSocketServer({
      server: this.httpsServer,
      path: '/socket',
      maxPayload: 1024 * 1024,
      perMessageDeflate: false
    });
    this.websocketServer.on('connection', (socket) => this.handleSocket(socket));

    await new Promise<void>((resolve, reject) => {
      const server = this.httpsServer!;
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.config.port, this.config.bindHost);
    });

    const address = this.httpsServer.address();
    if (!address || typeof address === 'string') throw new Error('Unable to determine server port.');
    const state = this.store.snapshot();
    this.infoValue = {
      serverId: state.serverId,
      serverName: state.settings.name,
      endpoint: `wss://${this.config.advertisedHost}:${address.port}/socket`,
      fingerprint: tls.fingerprint,
      port: address.port,
      dataDir: this.config.dataDir
    };
    this.log('info', 'Server started', this.infoValue);
    return this.info;
  }

  async stop(): Promise<void> {
    for (const context of this.sockets) context.socket.close(1001, 'Server shutting down');
    this.sockets.clear();
    this.sessions.clear();
    await new Promise<void>((resolve) => {
      if (!this.websocketServer) return resolve();
      this.websocketServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.httpsServer) return resolve();
      this.httpsServer.close(() => resolve());
    });
    this.websocketServer = null;
    this.httpsServer = null;
    this.infoValue = null;
  }

  private log(level: 'info' | 'warn' | 'error', message: string, detail: unknown = null): void {
    if (!this.config.debug && level === 'info') return;
    const entry = JSON.stringify({ time: now(), level, message, detail });
    console[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log'](entry);
    void mkdir(path.join(this.config.dataDir, 'logs'), { recursive: true, mode: 0o700 })
      .then(() => writeFile(path.join(this.config.dataDir, 'logs', 'localium.log'), `${entry}\n`, { flag: 'a', mode: 0o600 }))
      .catch(() => undefined);
  }

  private handleSocket(socket: WebSocket): void {
    const state = this.store.snapshot();
    const context: SocketContext = {
      socket,
      challenge: randomToken(),
      deviceId: null,
      pendingId: null,
      windowStartedAt: Date.now(),
      messageCount: 0
    };
    this.sockets.add(context);
    send(socket, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      serverId: state.serverId,
      serverName: state.settings.name,
      challenge: context.challenge,
      fingerprint: this.info.fingerprint
    });

    socket.on('message', (data) => {
      void this.onSocketMessage(context, data).catch((error) => {
        this.log('warn', 'Socket request rejected', { error: String(error), deviceId: context.deviceId });
        send(socket, { type: 'error', error: error instanceof Error ? error.message : 'Request failed.' });
      });
    });
    socket.on('close', () => this.sockets.delete(context));
    socket.on('error', (error) => this.log('warn', 'Socket error', { error: String(error) }));
  }

  private enforceRateLimit(context: SocketContext): void {
    const current = Date.now();
    if (current - context.windowStartedAt >= 60_000) {
      context.windowStartedAt = current;
      context.messageCount = 0;
    }
    context.messageCount += 1;
    if (context.messageCount > SOCKET_RATE_LIMIT_PER_MINUTE) {
      context.socket.close(1008, 'Rate limit exceeded');
      throw new Error('Rate limit exceeded.');
    }
  }

  private async onSocketMessage(context: SocketContext, data: RawData): Promise<void> {
    this.enforceRateLimit(context);
    const value = safeJsonParse(data);
    if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') {
      throw new Error('Invalid socket message.');
    }
    const message = value as ClientMessage;
    if (message.type === 'auth') return this.authenticate(context, message);
    if (message.type === 'join.request') return this.requestJoin(context, message);
    if (!context.deviceId) throw new Error('Authentication is required.');
    return this.handleAuthenticated(context, message);
  }

  private async authenticate(context: SocketContext, message: Extract<ClientMessage, { type: 'auth' }>): Promise<void> {
    const deviceId = idSchema.parse(message.deviceId);
    const state = this.store.snapshot();
    const member = getMemberOrThrow(state, deviceId);
    const valid = await verifyTextSignature(context.challenge, keySchema.parse(message.signature), member.signPublicKey);
    if (!valid) throw new Error('Device signature verification failed.');
    context.deviceId = deviceId;

    await this.store.transaction((draft) => {
      draft.members[deviceId].lastSeenAt = now();
    });
    const token = randomToken();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sessions.set(token, { token, deviceId, expiresAt });
    send(context.socket, {
      type: 'auth.ok',
      snapshot: this.buildAuthenticatedSnapshot(deviceId, token, expiresAt)
    });
    this.broadcast('member.online', { deviceId }, deviceId);
  }

  private async requestJoin(
    context: SocketContext,
    message: Extract<ClientMessage, { type: 'join.request' }>
  ): Promise<void> {
    const invite = decodeInvite(message.inviteCode);
    const state = this.store.snapshot();
    if (invite.serverId !== state.serverId || invite.fingerprint !== this.info.fingerprint) {
      throw new Error('Invitation does not match this server.');
    }
    const displayName = displayNameSchema.parse(message.displayName);
    const signPublicKey = keySchema.parse(message.signPublicKey);
    const boxPublicKey = keySchema.parse(message.boxPublicKey);
    const deviceId = idSchema.parse(message.deviceId);
    const derivedDeviceId = await deriveDeviceId(signPublicKey);
    if (derivedDeviceId !== deviceId) throw new Error('Device identity does not match its signing key.');
    const signatureValid = await verifyTextSignature(context.challenge, keySchema.parse(message.signature), signPublicKey);
    if (!signatureValid) throw new Error('Device signature verification failed.');

    const inviteRecord = state.invites[invite.secret.split('.')[0] ?? ''];
    if (!inviteRecord) throw new Error('Invitation does not exist.');
    const suppliedHash = hashSecret(invite.secret);
    if (!constantTimeSecretEqual(inviteRecord.secretHash, suppliedHash)) throw new Error('Invitation secret is invalid.');

    // A request that already consumed an invitation must remain recoverable after approval,
    // even when the invitation is now expired, revoked, or at its usage limit.
    const existingMember = state.members[deviceId];
    if (existingMember && !existingMember.revokedAt) {
      if (existingMember.signPublicKey !== signPublicKey || existingMember.boxPublicKey !== boxPublicKey) {
        throw new Error('Stored device keys do not match this membership.');
      }
      send(context.socket, {
        type: 'join.approved',
        pendingId: `existing:${deviceId}`,
        encryptedRoomKey: existingMember.encryptedRoomKey
      });
      return;
    }
    const existingPending = Object.values(state.pending).find((pending) => pending.deviceId === deviceId);
    if (existingPending) {
      if (existingPending.signPublicKey !== signPublicKey || existingPending.boxPublicKey !== boxPublicKey) {
        throw new Error('Stored device keys do not match this pending request.');
      }
      context.pendingId = existingPending.id;
      send(context.socket, { type: 'join.pending', pendingId: existingPending.id });
      return;
    }

    if (inviteRecord.revokedAt) throw new Error('Invitation has been revoked.');
    if (inviteRecord.expiresAt && Date.parse(inviteRecord.expiresAt) <= Date.now()) throw new Error('Invitation has expired.');
    if (inviteRecord.maxUses !== null && inviteRecord.useCount >= inviteRecord.maxUses) {
      throw new Error('Invitation usage limit has been reached.');
    }

    const pendingId = randomUUID();
    await this.store.transaction((draft) => {
      draft.pending[pendingId] = {
        id: pendingId,
        deviceId,
        displayName,
        signPublicKey,
        boxPublicKey,
        inviteId: inviteRecord.id,
        requestedAt: now()
      };
      draft.invites[inviteRecord.id].useCount += 1;
      draft.audit.push({
        id: randomUUID(),
        actorDeviceId: deviceId,
        action: 'join.requested',
        targetId: pendingId,
        createdAt: now(),
        detail: { displayName }
      });
    });
    context.pendingId = pendingId;
    send(context.socket, { type: 'join.pending', pendingId });
    this.broadcast('pending.created', this.store.snapshot().pending[pendingId], null, 'approve_members');
  }

  private async handleAuthenticated(context: SocketContext, message: ClientMessage): Promise<void> {
    const requestId = 'requestId' in message ? idSchema.parse(message.requestId) : randomUUID();
    try {
      const data = await this.dispatchAuthenticated(context.deviceId!, message);
      send(context.socket, { type: 'response', requestId, ok: true, data });
    } catch (error) {
      send(context.socket, {
        type: 'response',
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : 'Request failed.'
      });
    }
  }

  private requirePermission(deviceId: string, permission: Permission): { state: PersistedServerState; member: MemberRecord } {
    const state = this.store.snapshot();
    const member = getMemberOrThrow(state, deviceId);
    if (!hasPermission(state, member, permission)) throw new Error(`Missing permission: ${permission}`);
    return { state, member };
  }

  private async dispatchAuthenticated(deviceId: string, message: ClientMessage): Promise<unknown> {
    switch (message.type) {
      case 'invite.create':
        return this.createInvite(deviceId, message.permanent, message.maxUses);
      case 'invite.list':
        return this.listInvites(deviceId);
      case 'invite.revoke':
        return this.revokeInvite(deviceId, message.inviteId);
      case 'pending.list':
        return this.listPending(deviceId);
      case 'pending.approve':
        return this.approvePending(deviceId, message.pendingId, message.encryptedRoomKey, message.roleIds);
      case 'pending.reject':
        return this.rejectPending(deviceId, message.pendingId);
      case 'message.send':
        return this.sendMessage(deviceId, message.messageId, message.envelope);
      case 'member.update':
        return this.updateMember(deviceId, message.deviceId, message.displayName, message.roleIds);
      case 'member.remove':
        return this.removeMember(deviceId, message.deviceId);
      case 'role.create':
        return this.createRole(deviceId, message.name, message.color, message.permissions);
      case 'role.update':
        return this.updateRole(deviceId, message.roleId, message.name, message.color, message.permissions);
      case 'role.delete':
        return this.deleteRole(deviceId, message.roleId);
      case 'sticker.create':
        return this.createSticker(deviceId, message.label, message.assetId);
      case 'sticker.delete':
        return this.deleteSticker(deviceId, message.stickerId);
      case 'server.update':
        return this.updateServer(deviceId, message.name, message.backgroundAssetId);
      case 'member.avatar':
        return this.updateAvatar(deviceId, message.assetId);
      case 'command.execute':
        return this.executeCommand(deviceId, message.command, message.args);
      case 'mods.list':
        return this.listCommands(deviceId);
      case 'mods.reload':
        return this.reloadMods(deviceId);
      case 'audit.list':
        return this.listAudit(deviceId);
      case 'auth':
      case 'join.request':
        throw new Error('Invalid authenticated request.');
      default:
        throw new Error('Unsupported request type.');
    }
  }

  private async createInvite(deviceId: string, permanent: boolean, maxUses: number | null): Promise<{ code: string; invite: Omit<InviteRecord, 'secretHash'> }> {
    const { state } = this.requirePermission(deviceId, 'manage_invites');
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10_000)) {
      throw new Error('maxUses must be null or an integer between 1 and 10000.');
    }
    const inviteId = randomUUID();
    const secret = `${inviteId}.${randomToken(32)}`;
    const record: InviteRecord = {
      id: inviteId,
      secretHash: hashSecret(secret),
      createdBy: deviceId,
      createdAt: now(),
      expiresAt: permanent ? null : new Date(Date.now() + DEFAULT_INVITE_TTL_MS).toISOString(),
      revokedAt: null,
      useCount: 0,
      maxUses
    };
    await this.store.transaction((draft) => {
      draft.invites[inviteId] = record;
      draft.audit.push({
        id: randomUUID(),
        actorDeviceId: deviceId,
        action: 'invite.created',
        targetId: inviteId,
        createdAt: now(),
        detail: { permanent, maxUses }
      });
    });
    const code = encodeInvite({
      version: 1,
      endpoint: this.info.endpoint,
      serverId: state.serverId,
      serverName: state.settings.name,
      secret,
      fingerprint: this.info.fingerprint,
      expiresAt: record.expiresAt
    });
    this.broadcast('invite.changed', null, deviceId, 'manage_invites');
    return { code, invite: publicInvite(record) };
  }

  private listInvites(deviceId: string): Omit<InviteRecord, 'secretHash'>[] {
    const { state } = this.requirePermission(deviceId, 'manage_invites');
    return Object.values(state.invites).map(publicInvite);
  }

  private async revokeInvite(deviceId: string, inviteId: string): Promise<void> {
    this.requirePermission(deviceId, 'manage_invites');
    idSchema.parse(inviteId);
    await this.store.transaction((draft) => {
      const invite = draft.invites[inviteId];
      if (!invite) throw new Error('Invitation does not exist.');
      invite.revokedAt = now();
      draft.audit.push({
        id: randomUUID(),
        actorDeviceId: deviceId,
        action: 'invite.revoked',
        targetId: inviteId,
        createdAt: now(),
        detail: {}
      });
    });
    this.broadcast('invite.changed', null, deviceId, 'manage_invites');
  }

  private listPending(deviceId: string): unknown[] {
    const { state } = this.requirePermission(deviceId, 'approve_members');
    return Object.values(state.pending);
  }

  private async approvePending(deviceId: string, pendingId: string, encryptedRoomKey: string, roleIds: string[]): Promise<MemberRecord> {
    this.requirePermission(deviceId, 'approve_members');
    idSchema.parse(pendingId);
    keySchema.parse(encryptedRoomKey);
    if (!Array.isArray(roleIds) || roleIds.length === 0 || roleIds.length > 20) throw new Error('At least one valid role is required.');
    const member = await this.store.transaction((draft) => {
      const pending = draft.pending[pendingId];
      if (!pending) throw new Error('Join request does not exist.');
      const validRoleIds = [...new Set(roleIds.map((roleId) => idSchema.parse(roleId)))];
      assertDelegableRoles(draft, deviceId, validRoleIds);
      const timestamp = now();
      const approved: MemberRecord = {
        deviceId: pending.deviceId,
        displayName: pending.displayName,
        avatarAssetId: null,
        signPublicKey: pending.signPublicKey,
        boxPublicKey: pending.boxPublicKey,
        roleIds: validRoleIds,
        encryptedRoomKey,
        approvedAt: timestamp,
        lastSeenAt: timestamp,
        revokedAt: null
      };
      draft.members[approved.deviceId] = approved;
      delete draft.pending[pendingId];
      draft.audit.push({
        id: randomUUID(),
        actorDeviceId: deviceId,
        action: 'member.approved',
        targetId: approved.deviceId,
        createdAt: timestamp,
        detail: { displayName: approved.displayName }
      });
      return approved;
    });
    for (const context of this.sockets) {
      if (context.pendingId === pendingId) {
        send(context.socket, { type: 'join.approved', pendingId, encryptedRoomKey });
      }
    }
    this.broadcast('member.changed', member);
    return member;
  }

  private async rejectPending(deviceId: string, pendingId: string): Promise<void> {
    this.requirePermission(deviceId, 'approve_members');
    idSchema.parse(pendingId);
    await this.store.transaction((draft) => {
      if (!draft.pending[pendingId]) throw new Error('Join request does not exist.');
      delete draft.pending[pendingId];
      draft.audit.push({
        id: randomUUID(),
        actorDeviceId: deviceId,
        action: 'member.rejected',
        targetId: pendingId,
        createdAt: now(),
        detail: {}
      });
    });
    for (const context of this.sockets) {
      if (context.pendingId === pendingId) send(context.socket, { type: 'join.rejected', pendingId });
    }
    this.broadcast('pending.changed', null, deviceId, 'approve_members');
  }

  private async sendMessage(deviceId: string, messageId: string, envelopeValue: unknown): Promise<void> {
    this.requirePermission(deviceId, 'send_messages');
    idSchema.parse(messageId);
    const envelope = validateEncryptedEnvelope(envelopeValue);
    if (envelope.aad !== `message:${messageId}`) throw new Error('Encrypted message metadata does not match its id.');
    const message = await this.store.transaction((draft) => {
      if (draft.messages.some((entry) => entry.id === messageId)) throw new Error('Duplicate message id.');
      const record = {
        id: messageId,
        senderDeviceId: deviceId,
        envelope,
        createdAt: now(),
        editedAt: null
      };
      draft.messages.push(record);
      return record;
    });
    this.broadcast('message.created', message);
  }

  private async updateMember(actorDeviceId: string, targetDeviceId: string, displayName?: string, roleIds?: string[]): Promise<MemberRecord> {
    const { state } = this.requirePermission(actorDeviceId, 'manage_members');
    idSchema.parse(targetDeviceId);
    if (targetDeviceId === state.ownerDeviceId && actorDeviceId !== state.ownerDeviceId) {
      throw new Error('Only the owner can update the owner account.');
    }
    const updated = await this.store.transaction((draft) => {
      const target = getMemberOrThrow(draft, targetDeviceId);
      assertManageableMember(draft, actorDeviceId, target);
      if (displayName !== undefined) target.displayName = displayNameSchema.parse(displayName);
      if (roleIds !== undefined) {
        if (targetDeviceId === draft.ownerDeviceId) throw new Error('Owner roles cannot be changed.');
        const uniqueRoles = [...new Set(roleIds.map((roleId) => idSchema.parse(roleId)))];
        if (uniqueRoles.length === 0) throw new Error('At least one role is required.');
        assertDelegableRoles(draft, actorDeviceId, uniqueRoles);
        target.roleIds = uniqueRoles;
      }
      draft.audit.push({
        id: randomUUID(),
        actorDeviceId,
        action: 'member.updated',
        targetId: targetDeviceId,
        createdAt: now(),
        detail: {}
      });
      return structuredClone(target);
    });
    this.broadcast('member.changed', updated);
    return updated;
  }

  private async removeMember(actorDeviceId: string, targetDeviceId: string): Promise<void> {
    const { state } = this.requirePermission(actorDeviceId, 'manage_members');
    idSchema.parse(targetDeviceId);
    if (targetDeviceId === state.ownerDeviceId) throw new Error('The owner cannot be removed.');
    await this.store.transaction((draft) => {
      const target = getMemberOrThrow(draft, targetDeviceId);
      assertManageableMember(draft, actorDeviceId, target);
      target.revokedAt = now();
      draft.audit.push({
        id: randomUUID(),
        actorDeviceId,
        action: 'member.removed',
        targetId: targetDeviceId,
        createdAt: now(),
        detail: { displayName: target.displayName }
      });
    });
    for (const context of this.sockets) {
      if (context.deviceId === targetDeviceId) context.socket.close(1008, 'Membership revoked');
    }
    this.broadcast('member.changed', { deviceId: targetDeviceId, removed: true });
  }

  private async createRole(deviceId: string, name: string, color: string, permissions: unknown): Promise<RoleRecord> {
    this.requirePermission(deviceId, 'manage_roles');
    const parsedPermissions = parsePermissions(permissions);
    const currentState = this.store.snapshot();
    assertDelegablePermissions(currentState, deviceId, parsedPermissions);
    const role: RoleRecord = {
      id: randomUUID(),
      name: roleNameSchema.parse(name),
      color: colorSchema.parse(color),
      permissions: parsedPermissions,
      system: false
    };
    await this.store.transaction((draft) => {
      draft.roles[role.id] = role;
      draft.audit.push({
        id: randomUUID(), actorDeviceId: deviceId, action: 'role.created', targetId: role.id, createdAt: now(), detail: { name: role.name }
      });
    });
    this.broadcast('role.changed', role);
    return role;
  }

  private async updateRole(deviceId: string, roleId: string, name: string, color: string, permissions: unknown): Promise<RoleRecord> {
    this.requirePermission(deviceId, 'manage_roles');
    idSchema.parse(roleId);
    const updated = await this.store.transaction((draft) => {
      const role = draft.roles[roleId];
      if (!role) throw new Error('Role does not exist.');
      if (role.system) throw new Error('System roles cannot be edited.');
      assertDelegablePermissions(draft, deviceId, role.permissions);
      const parsedPermissions = parsePermissions(permissions);
      assertDelegablePermissions(draft, deviceId, parsedPermissions);
      role.name = roleNameSchema.parse(name);
      role.color = colorSchema.parse(color);
      role.permissions = parsedPermissions;
      draft.audit.push({
        id: randomUUID(), actorDeviceId: deviceId, action: 'role.updated', targetId: role.id, createdAt: now(), detail: { name: role.name }
      });
      return structuredClone(role);
    });
    this.broadcast('role.changed', updated);
    return updated;
  }

  private async deleteRole(deviceId: string, roleId: string): Promise<void> {
    this.requirePermission(deviceId, 'manage_roles');
    idSchema.parse(roleId);
    await this.store.transaction((draft) => {
      const role = draft.roles[roleId];
      if (!role) throw new Error('Role does not exist.');
      if (role.system) throw new Error('System roles cannot be deleted.');
      assertDelegablePermissions(draft, deviceId, role.permissions);
      delete draft.roles[roleId];
      for (const member of Object.values(draft.members)) {
        member.roleIds = member.roleIds.filter((id) => id !== roleId);
        if (member.roleIds.length === 0 && member.deviceId !== draft.ownerDeviceId) member.roleIds = ['member'];
      }
      draft.audit.push({
        id: randomUUID(), actorDeviceId: deviceId, action: 'role.deleted', targetId: roleId, createdAt: now(), detail: { name: role.name }
      });
    });
    this.broadcast('role.changed', { roleId, deleted: true });
  }

  private async createSticker(deviceId: string, label: string, assetId: string): Promise<unknown> {
    const { state } = this.requirePermission(deviceId, 'manage_stickers');
    idSchema.parse(assetId);
    const asset = state.assets[assetId];
    if (!asset || asset.kind !== 'sticker') throw new Error('Sticker asset does not exist.');
    const sticker = {
      id: randomUUID(),
      label: stickerLabelSchema.parse(label),
      assetId,
      builtInEmoji: null,
      createdBy: deviceId,
      createdAt: now()
    };
    await this.store.transaction((draft) => {
      draft.stickers[sticker.id] = sticker;
      draft.audit.push({
        id: randomUUID(), actorDeviceId: deviceId, action: 'sticker.created', targetId: sticker.id, createdAt: now(), detail: { label: sticker.label }
      });
    });
    this.broadcast('sticker.changed', sticker);
    return sticker;
  }

  private async deleteSticker(deviceId: string, stickerId: string): Promise<void> {
    this.requirePermission(deviceId, 'manage_stickers');
    idSchema.parse(stickerId);
    await this.store.transaction((draft) => {
      const sticker = draft.stickers[stickerId];
      if (!sticker) throw new Error('Sticker does not exist.');
      if (sticker.builtInEmoji) throw new Error('Built-in stickers cannot be deleted.');
      delete draft.stickers[stickerId];
      draft.audit.push({
        id: randomUUID(), actorDeviceId: deviceId, action: 'sticker.deleted', targetId: stickerId, createdAt: now(), detail: { label: sticker.label }
      });
    });
    this.broadcast('sticker.changed', { stickerId, deleted: true });
  }

  private async updateServer(deviceId: string, name?: string, backgroundAssetId?: string | null): Promise<unknown> {
    this.requirePermission(deviceId, 'manage_server');
    const settings = await this.store.transaction((draft) => {
      if (name !== undefined) draft.settings.name = serverNameSchema.parse(name);
      if (backgroundAssetId !== undefined) {
        if (backgroundAssetId !== null) {
          idSchema.parse(backgroundAssetId);
          const asset = draft.assets[backgroundAssetId];
          if (!asset || asset.kind !== 'background') throw new Error('Background asset does not exist.');
        }
        draft.settings.backgroundAssetId = backgroundAssetId;
      }
      draft.audit.push({
        id: randomUUID(), actorDeviceId: deviceId, action: 'server.updated', targetId: draft.serverId, createdAt: now(), detail: {}
      });
      return structuredClone(draft.settings);
    });
    if (this.infoValue) this.infoValue.serverName = settings.name;
    this.broadcast('server.changed', settings);
    return settings;
  }

  private async updateAvatar(deviceId: string, assetId: string | null): Promise<MemberRecord> {
    if (assetId !== null) idSchema.parse(assetId);
    const updated = await this.store.transaction((draft) => {
      const member = getMemberOrThrow(draft, deviceId);
      if (assetId !== null) {
        const asset = draft.assets[assetId];
        if (!asset || asset.kind !== 'avatar' || asset.ownerDeviceId !== deviceId) throw new Error('Avatar asset does not exist.');
      }
      member.avatarAssetId = assetId;
      draft.audit.push({
        id: randomUUID(), actorDeviceId: deviceId, action: 'member.avatar.updated', targetId: deviceId, createdAt: now(), detail: { cleared: assetId === null }
      });
      return structuredClone(member);
    });
    this.broadcast('member.changed', updated);
    return updated;
  }

  private listCommands(deviceId: string): unknown[] {
    const state = this.store.snapshot();
    const member = getMemberOrThrow(state, deviceId);
    return this.mods?.list(rolePermissions(state, member)) ?? [];
  }

  private async reloadMods(deviceId: string): Promise<unknown[]> {
    this.requirePermission(deviceId, 'manage_mods');
    if (!this.mods) throw new Error('Mod registry is not available.');
    await this.mods.reload();
    await this.store.appendAudit(deviceId, 'mods.reloaded', null, {});
    this.broadcast('mods.changed', null);
    return this.listCommands(deviceId);
  }

  private async executeCommand(deviceId: string, command: string, args: string): Promise<CommandExecutionResult> {
    const state = this.store.snapshot();
    const member = getMemberOrThrow(state, deviceId);
    if (!this.mods) throw new Error('Mod registry is not available.');
    const result = this.mods.execute(command, args, { displayName: member.displayName, serverName: state.settings.name }, rolePermissions(state, member));
    await this.store.appendAudit(deviceId, 'command.executed', result.moduleId, { command: result.command });
    return result;
  }

  private listAudit(deviceId: string): unknown[] {
    const { state } = this.requirePermission(deviceId, 'view_audit');
    return state.audit.slice(-500).reverse();
  }

  private buildAuthenticatedSnapshot(deviceId: string, token: string, expiresAt: number): AuthenticatedSnapshot {
    const state = this.store.snapshot();
    const self = getMemberOrThrow(state, deviceId);
    const permissions = rolePermissions(state, self);
    return {
      ...publicSnapshot(state),
      self,
      encryptedRoomKey: self.encryptedRoomKey,
      pending: permissions.has('approve_members') ? Object.values(state.pending) : [],
      invites: permissions.has('manage_invites') ? Object.values(state.invites).map(publicInvite) : [],
      audit: permissions.has('view_audit') ? state.audit.slice(-500).reverse() : [],
      sessionToken: token,
      sessionExpiresAt: new Date(expiresAt).toISOString(),
      commands: this.mods?.list(permissions) ?? []
    };
  }

  private broadcast(event: string, payload: unknown, exceptDeviceId: string | null = null, requiredPermission?: Permission): void {
    const state = this.store.snapshot();
    for (const context of this.sockets) {
      if (!context.deviceId || context.deviceId === exceptDeviceId) continue;
      const member = state.members[context.deviceId];
      if (!member || member.revokedAt) continue;
      if (requiredPermission && !hasPermission(state, member, requiredPermission)) continue;
      send(context.socket, { type: 'event', event, payload });
    }
  }

  private authenticatedSession(request: IncomingMessage): SessionRecord | null {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) return null;
    const token = authorization.slice('Bearer '.length);
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    const state = this.store.snapshot();
    const member = state.members[session.deviceId];
    if (!member || member.revokedAt) return null;
    return session;
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setCors(response);
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url ?? '/', `https://${request.headers.host ?? 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      const state = this.store.snapshot();
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, serverId: state.serverId, serverName: state.settings.name, protocolVersion: PROTOCOL_VERSION }));
      return;
    }

    const session = this.authenticatedSession(request);
    if (!session) return responseError(response, 401, 'Authentication is required.');

    if (request.method === 'POST' && url.pathname === '/api/assets') {
      const kind = url.searchParams.get('kind');
      if (kind !== 'attachment' && kind !== 'sticker' && kind !== 'background' && kind !== 'avatar') {
        return responseError(response, 400, 'Invalid asset kind.');
      }
      const state = this.store.snapshot();
      const member = getMemberOrThrow(state, session.deviceId);
      const permission: Permission | null = kind === 'attachment' ? 'send_files' : kind === 'sticker' ? 'manage_stickers' : kind === 'background' ? 'manage_server' : null;
      if (permission && !hasPermission(state, member, permission)) return responseError(response, 403, `Missing permission: ${permission}`);
      const declaredLength = Number(request.headers['content-length'] ?? 0);
      if (!Number.isFinite(declaredLength) || declaredLength <= 0 || declaredLength > MAX_ASSET_BYTES + 128) {
        return responseError(response, 413, 'Encrypted asset is too large or empty.');
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_ASSET_BYTES + 128) return responseError(response, 413, 'Encrypted asset is too large.');
        chunks.push(buffer);
      }
      if (total === 0) return responseError(response, 400, 'Encrypted asset is empty.');
      const assetId = randomUUID();
      const assetPath = this.store.assetPath(assetId);
      await writeFile(assetPath, Buffer.concat(chunks), { mode: 0o600 });
      const record: AssetRecord = {
        id: assetId,
        ownerDeviceId: session.deviceId,
        kind,
        byteLength: total,
        createdAt: now()
      };
      try {
        await this.store.transaction((draft) => {
          draft.assets[assetId] = record;
          draft.audit.push({
            id: randomUUID(),
            actorDeviceId: session.deviceId,
            action: 'asset.uploaded',
            targetId: assetId,
            createdAt: now(),
            detail: { kind, byteLength: total }
          });
        });
      } catch (error) {
        await unlink(assetPath).catch(() => undefined);
        throw error;
      }
      response.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ assetId, byteLength: total }));
      return;
    }

    const assetMatch = /^\/api\/assets\/([a-f0-9-]{36})$/u.exec(url.pathname);
    if (request.method === 'GET' && assetMatch) {
      const assetId = assetMatch[1];
      const state = this.store.snapshot();
      const asset = state.assets[assetId];
      if (!asset) return responseError(response, 404, 'Asset does not exist.');
      const assetPath = this.store.assetPath(assetId);
      try {
        await access(assetPath);
      } catch {
        return responseError(response, 404, 'Asset data is missing.');
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(asset.byteLength),
        'content-disposition': `attachment; filename="${assetId}.bin"`
      });
      createReadStream(assetPath).pipe(response);
      return;
    }

    responseError(response, 404, 'Endpoint not found.');
  }
}
