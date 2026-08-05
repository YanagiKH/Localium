import type { Permission } from './constants.js';

export interface DeviceIdentity {
  deviceId: string;
  signPublicKey: string;
  signPrivateKey: string;
  boxPublicKey: string;
  boxPrivateKey: string;
}

export interface EncryptedEnvelope {
  version: 1;
  nonce: string;
  ciphertext: string;
  aad: string;
}

export interface ServerKeyRecord {
  endpoint: string;
  fingerprint: string;
  roomKey: string;
  serverName: string;
}

export interface VaultData {
  identity: DeviceIdentity;
  servers: Record<string, ServerKeyRecord>;
}

export interface InvitePayload {
  version: 1;
  endpoint: string;
  serverId: string;
  serverName: string;
  secret: string;
  fingerprint: string;
  expiresAt: string | null;
}

export interface RoleRecord {
  id: string;
  name: string;
  color: string;
  permissions: Permission[];
  system: boolean;
}

export interface MemberRecord {
  deviceId: string;
  displayName: string;
  signPublicKey: string;
  boxPublicKey: string;
  roleIds: string[];
  encryptedRoomKey: string;
  approvedAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface PendingJoinRecord {
  id: string;
  deviceId: string;
  displayName: string;
  signPublicKey: string;
  boxPublicKey: string;
  inviteId: string;
  requestedAt: string;
}

export interface InviteRecord {
  id: string;
  secretHash: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  useCount: number;
  maxUses: number | null;
}

export interface MessageRecord {
  id: string;
  senderDeviceId: string;
  envelope: EncryptedEnvelope;
  createdAt: string;
  editedAt: string | null;
}

export interface StickerRecord {
  id: string;
  label: string;
  assetId: string | null;
  builtInEmoji: string | null;
  createdBy: string;
  createdAt: string;
}

export interface AssetRecord {
  id: string;
  ownerDeviceId: string;
  kind: 'attachment' | 'sticker' | 'background';
  byteLength: number;
  createdAt: string;
}

export interface AuditRecord {
  id: string;
  actorDeviceId: string;
  action: string;
  targetId: string | null;
  createdAt: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface ServerSettings {
  name: string;
  backgroundAssetId: string | null;
  maxAssetBytes: number;
  approvalRequired: true;
}

export interface PersistedServerState {
  schemaVersion: 1;
  serverId: string;
  createdAt: string;
  ownerDeviceId: string;
  settings: ServerSettings;
  members: Record<string, MemberRecord>;
  pending: Record<string, PendingJoinRecord>;
  invites: Record<string, InviteRecord>;
  roles: Record<string, RoleRecord>;
  messages: MessageRecord[];
  stickers: Record<string, StickerRecord>;
  assets: Record<string, AssetRecord>;
  audit: AuditRecord[];
}

export interface PublicServerSnapshot {
  serverId: string;
  ownerDeviceId: string;
  settings: ServerSettings;
  members: MemberRecord[];
  roles: RoleRecord[];
  stickers: StickerRecord[];
  messages: MessageRecord[];
}

export interface AuthenticatedSnapshot extends PublicServerSnapshot {
  self: MemberRecord;
  encryptedRoomKey: string;
  pending: PendingJoinRecord[];
  invites: Omit<InviteRecord, 'secretHash'>[];
  audit: AuditRecord[];
  sessionToken: string;
  sessionExpiresAt: string;
}

export type ClientMessage =
  | { type: 'auth'; deviceId: string; signature: string }
  | {
      type: 'join.request';
      inviteCode: string;
      displayName: string;
      deviceId: string;
      signPublicKey: string;
      boxPublicKey: string;
      signature: string;
    }
  | { type: 'invite.create'; requestId: string; permanent: boolean; maxUses: number | null }
  | { type: 'invite.list'; requestId: string }
  | { type: 'invite.revoke'; requestId: string; inviteId: string }
  | { type: 'pending.list'; requestId: string }
  | { type: 'pending.approve'; requestId: string; pendingId: string; encryptedRoomKey: string; roleIds: string[] }
  | { type: 'pending.reject'; requestId: string; pendingId: string }
  | { type: 'message.send'; requestId: string; messageId: string; envelope: EncryptedEnvelope }
  | { type: 'member.update'; requestId: string; deviceId: string; displayName?: string; roleIds?: string[] }
  | { type: 'member.remove'; requestId: string; deviceId: string }
  | { type: 'role.create'; requestId: string; name: string; color: string; permissions: Permission[] }
  | { type: 'role.update'; requestId: string; roleId: string; name: string; color: string; permissions: Permission[] }
  | { type: 'role.delete'; requestId: string; roleId: string }
  | { type: 'sticker.create'; requestId: string; label: string; assetId: string }
  | { type: 'sticker.delete'; requestId: string; stickerId: string }
  | { type: 'server.update'; requestId: string; name?: string; backgroundAssetId?: string | null }
  | { type: 'audit.list'; requestId: string };

export type ServerMessage =
  | { type: 'hello'; protocolVersion: number; serverId: string; serverName: string; challenge: string; fingerprint: string }
  | { type: 'auth.ok'; snapshot: AuthenticatedSnapshot }
  | { type: 'join.pending'; pendingId: string }
  | { type: 'join.approved'; pendingId: string; encryptedRoomKey: string }
  | { type: 'join.rejected'; pendingId: string }
  | { type: 'event'; event: string; payload: unknown }
  | { type: 'response'; requestId: string; ok: true; data?: unknown }
  | { type: 'response'; requestId: string; ok: false; error: string }
  | { type: 'error'; error: string };

export interface DecryptedChatPayload {
  kind: 'text' | 'file' | 'sticker' | 'system';
  text?: string;
  assetId?: string;
  fileName?: string;
  mimeType?: string;
  byteLength?: number;
  stickerId?: string;
}
