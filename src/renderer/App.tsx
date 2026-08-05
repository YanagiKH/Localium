import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent } from 'react';
import {
  decryptBytes,
  decryptJson,
  encryptBytes,
  encryptJson,
  generateIdentity,
  generateRoomKey,
  openSealedRoomKey,
  sealRoomKey
} from '../shared/crypto.js';
import { decodeInvite } from '../shared/invite.js';
import { MAX_ASSET_BYTES, PERMISSIONS, type Permission } from '../shared/constants.js';
import type {
  AuthenticatedSnapshot,
  CommandExecutionResult,
  CommandSummary,
  DecryptedChatPayload,
  InviteRecord,
  MemberRecord,
  MessageRecord,
  PendingJoinRecord,
  RoleRecord,
  ServerKeyRecord,
  StickerRecord,
  VaultData
} from '../shared/types.js';
import type { HostedServerSummary } from '../shared/desktop-api.js';
import { LocaliumClient } from './lib/client.js';
import './styles.css';

type Screen = 'landing' | 'create' | 'join' | 'pending' | 'chat';

interface DecryptedMessage extends MessageRecord {
  payload: DecryptedChatPayload | null;
  failed: boolean;
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index < 0) return [...items, item];
  const copy = [...items];
  copy[index] = item;
  return copy;
}

async function decryptMessages(roomKey: string, messages: MessageRecord[]): Promise<DecryptedMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      try {
        const payload = await decryptJson<DecryptedChatPayload>(roomKey, message.envelope, `message:${message.id}`);
        return { ...message, payload, failed: false };
      } catch {
        return { ...message, payload: null, failed: true };
      }
    })
  );
}

function memberPermissions(snapshot: AuthenticatedSnapshot | null): Set<Permission> {
  if (!snapshot) return new Set();
  const permissions = new Set<Permission>();
  for (const roleId of snapshot.self.roleIds) {
    const role = snapshot.roles.find((entry) => entry.id === roleId);
    for (const permission of role?.permissions ?? []) permissions.add(permission);
  }
  return permissions;
}

function memberName(snapshot: AuthenticatedSnapshot, deviceId: string): string {
  return snapshot.members.find((member) => member.deviceId === deviceId)?.displayName ?? 'Former member';
}

function MemberAvatar({ member, url, large = false }: { member: MemberRecord; url?: string; large?: boolean }) {
  return (
    <span className={`avatar${large ? ' avatar-large' : ''}`}>
      {url ? <img src={url} alt={`${member.displayName} avatar`} /> : member.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('landing');
  const [vault, setVault] = useState<VaultData | null>(null);
  const [hostedServers, setHostedServers] = useState<HostedServerSummary[]>([]);
  const [snapshot, setSnapshot] = useState<AuthenticatedSnapshot | null>(null);
  const [roomKey, setRoomKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [status, setStatus] = useState('Loading secure device identity…');
  const [error, setError] = useState('');
  const [pendingId, setPendingId] = useState('');
  const [messageText, setMessageText] = useState('');
  const [adminOpen, setAdminOpen] = useState(false);
  const [newInviteCode, setNewInviteCode] = useState('');
  const [debugLogs, setDebugLogs] = useState('');
  const [debugOpen, setDebugOpen] = useState(false);
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [stickerUrls, setStickerUrls] = useState<Record<string, string>>({});
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string>>({});
  const [platform, setPlatform] = useState<'desktop' | 'android' | 'unknown'>('unknown');
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const clientRef = useRef<LocaliumClient | null>(null);
  const initializedRef = useRef(false);
  const snapshotRef = useRef<AuthenticatedSnapshot | null>(null);
  const roomKeyRef = useRef<string | null>(null);
  const permissions = useMemo(() => memberPermissions(snapshot), [snapshot]);
  const commandSuggestions = useMemo(() => {
    if (!snapshot || !messageText.startsWith('/')) return [];
    const query = messageText.slice(1).split(/\s/u)[0]?.toLowerCase() ?? '';
    return snapshot.commands.filter((command) => command.name.startsWith(query)).slice(0, 8);
  }, [snapshot, messageText]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  useEffect(() => {
    roomKeyRef.current = roomKey;
  }, [roomKey]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void initialize();
    return () => {
      clientRef.current?.close();
      if (backgroundUrl) URL.revokeObjectURL(backgroundUrl);
      for (const value of Object.values(stickerUrls)) URL.revokeObjectURL(value);
      for (const value of Object.values(avatarUrls)) URL.revokeObjectURL(value);
    };
    // The cleanup intentionally uses the initial URL sets; runtime replacements are revoked before assignment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function initialize(): Promise<void> {
    try {
      let loaded = await window.localium.vault.load();
      if (!loaded) {
        loaded = { identity: await generateIdentity(), servers: {} };
        await window.localium.vault.save(loaded);
      }
      setVault(loaded);
      const runtime = await window.localium.app.getPlatform();
      setPlatform(runtime);
      setHostedServers(runtime === 'desktop' ? await window.localium.server.listHosted() : []);
      setStatus('Device identity is secured by the operating system.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to initialize Localium.');
      setStatus('Initialization failed.');
    }
  }

  async function persistVault(next: VaultData): Promise<void> {
    await window.localium.vault.save(next);
    setVault(next);
  }

  function bindClientEvents(client: LocaliumClient): void {
    client.on('message.created', (payload) => {
      const key = roomKeyRef.current;
      if (!key) return;
      void decryptMessages(key, [payload as MessageRecord]).then(([message]) => {
        setMessages((current) => current.some((entry) => entry.id === message.id) ? current : [...current, message]);
      });
    });
    client.on('pending.created', (payload) => {
      setSnapshot((current) => current ? { ...current, pending: upsert(current.pending, payload as PendingJoinRecord) } : current);
    });
    client.on('pending.changed', () => {
      void client.request<PendingJoinRecord[]>({ type: 'pending.list' }).then((pending) => {
        setSnapshot((current) => current ? { ...current, pending } : current);
      }).catch(() => undefined);
    });
    client.on('member.changed', (payload) => {
      const value = payload as MemberRecord & { removed?: boolean };
      setSnapshot((current) => {
        if (!current) return current;
        if (value.removed) return { ...current, members: current.members.filter((member) => member.deviceId !== value.deviceId) };
        const index = current.members.findIndex((member) => member.deviceId === value.deviceId);
        if (index < 0) return { ...current, members: [...current.members, value] };
        const members = [...current.members];
        members[index] = value;
        return { ...current, members };
      });
      const key = roomKeyRef.current;
      if (!value.removed && value.avatarAssetId && key) {
        void loadAvatarAsset(client, key, value);
      } else {
        setAvatarUrls((current) => {
          if (current[value.deviceId]) URL.revokeObjectURL(current[value.deviceId]);
          const next = { ...current };
          delete next[value.deviceId];
          return next;
        });
      }
    });
    client.on('role.changed', (payload) => {
      const value = payload as RoleRecord & { roleId?: string; deleted?: boolean };
      setSnapshot((current) => {
        if (!current) return current;
        if (value.deleted && value.roleId) return { ...current, roles: current.roles.filter((role) => role.id !== value.roleId) };
        return { ...current, roles: upsert(current.roles, value) };
      });
    });
    client.on('sticker.changed', (payload) => {
      const value = payload as StickerRecord & { stickerId?: string; deleted?: boolean };
      setSnapshot((current) => {
        if (!current) return current;
        if (value.deleted && value.stickerId) return { ...current, stickers: current.stickers.filter((sticker) => sticker.id !== value.stickerId) };
        return { ...current, stickers: upsert(current.stickers, value) };
      });
      const key = roomKeyRef.current;
      if (!value.deleted && value.assetId && key) {
        void loadStickerAsset(client, key, value);
      } else if (value.deleted && value.stickerId) {
        setStickerUrls((current) => {
          if (current[value.stickerId!]) URL.revokeObjectURL(current[value.stickerId!]);
          const next = { ...current };
          delete next[value.stickerId!];
          return next;
        });
      }
    });
    client.on('server.changed', (payload) => {
      const settings = payload as AuthenticatedSnapshot['settings'];
      setSnapshot((current) => current ? { ...current, settings } : current);
      const key = roomKeyRef.current;
      if (key) void loadBackgroundAsset(client, key, settings.backgroundAssetId);
    });
    client.on('mods.changed', () => {
      void client.request<CommandSummary[]>({ type: 'mods.list' }).then((commands) => {
        setSnapshot((current) => current ? { ...current, commands } : current);
      }).catch(() => undefined);
    });
    client.on('invite.changed', () => {
      void client.request<Array<Omit<InviteRecord, 'secretHash'>>>({ type: 'invite.list' }).then((invites) => {
        setSnapshot((current) => current ? { ...current, invites } : current);
      }).catch(() => undefined);
    });
    client.on('connection.closed', () => setStatus('Disconnected from server.'));
    client.on('connection.error', () => setError('Unable to establish a trusted connection.'));
  }

  async function loadStickerAsset(client: LocaliumClient, key: string, sticker: StickerRecord): Promise<void> {
    if (!sticker.assetId) return;
    try {
      const encrypted = await client.downloadAsset(sticker.assetId);
      const decrypted = await decryptBytes(key, encrypted, 'sticker-asset');
      const bytes = decrypted.buffer.slice(decrypted.byteOffset, decrypted.byteOffset + decrypted.byteLength) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([bytes]));
      setStickerUrls((current) => {
        if (current[sticker.id]) URL.revokeObjectURL(current[sticker.id]);
        return { ...current, [sticker.id]: url };
      });
    } catch {
      // The message remains readable even when an optional sticker image cannot be loaded.
    }
  }

  async function loadAvatarAsset(client: LocaliumClient, key: string, member: MemberRecord): Promise<void> {
    if (!member.avatarAssetId) return;
    try {
      const encrypted = await client.downloadAsset(member.avatarAssetId);
      const decrypted = await decryptBytes(key, encrypted, `avatar-asset:${member.deviceId}`);
      const bytes = decrypted.buffer.slice(decrypted.byteOffset, decrypted.byteOffset + decrypted.byteLength) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([bytes]));
      setAvatarUrls((current) => {
        if (current[member.deviceId]) URL.revokeObjectURL(current[member.deviceId]);
        return { ...current, [member.deviceId]: url };
      });
    } catch {
      // Fall back to initials if an optional avatar cannot be decrypted.
    }
  }

  async function loadBackgroundAsset(client: LocaliumClient, key: string, assetId: string | null): Promise<void> {
    if (!assetId) {
      setBackgroundUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
      return;
    }
    try {
      const encrypted = await client.downloadAsset(assetId);
      const decrypted = await decryptBytes(key, encrypted, 'background-asset');
      const bytes = decrypted.buffer.slice(decrypted.byteOffset, decrypted.byteOffset + decrypted.byteLength) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([bytes]));
      setBackgroundUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return url;
      });
    } catch {
      setBackgroundUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    }
  }

  async function loadVisualAssets(client: LocaliumClient, key: string, nextSnapshot: AuthenticatedSnapshot): Promise<void> {
    for (const member of nextSnapshot.members) {
      if (member.avatarAssetId) void loadAvatarAsset(client, key, member);
    }
    for (const sticker of nextSnapshot.stickers) {
      if (sticker.assetId) void loadStickerAsset(client, key, sticker);
    }
    await loadBackgroundAsset(client, key, nextSnapshot.settings.backgroundAssetId);
  }

  async function connect(serverId: string, record: ServerKeyRecord): Promise<void> {
    if (!vault) throw new Error('Device vault is not ready.');
    setError('');
    setStatus(`Connecting to ${record.serverName}…`);
    await window.localium.security.trustFingerprint(record.fingerprint);
    clientRef.current?.close();
    const client = new LocaliumClient(record.endpoint, vault.identity);
    clientRef.current = client;
    bindClientEvents(client);
    const nextSnapshot = await client.authenticate();
    if (nextSnapshot.serverId !== serverId) throw new Error('Connected server identity does not match the saved server.');
    setSnapshot(nextSnapshot);
    setRoomKey(record.roomKey);
    setMessages(await decryptMessages(record.roomKey, nextSnapshot.messages));
    await loadVisualAssets(client, record.roomKey, nextSnapshot);
    setScreen('chat');
    setStatus(`Connected with end-to-end encryption · ${nextSnapshot.members.length} member${nextSnapshot.members.length === 1 ? '' : 's'}`);
  }

  async function openSavedServer(serverId: string): Promise<void> {
    if (!vault) return;
    try {
      let record = vault.servers[serverId];
      if (!record) throw new Error('Saved server key is missing.');
      const hosted = hostedServers.find((entry) => entry.serverId === serverId);
      if (hosted) {
        const info = await window.localium.server.startExisting(serverId, hosted.port);
        record = { ...record, endpoint: info.endpoint, fingerprint: info.fingerprint, serverName: info.serverName };
        await persistVault({ ...vault, servers: { ...vault.servers, [serverId]: record } });
      }
      await connect(serverId, record);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to connect to the server.');
      setStatus('Connection failed.');
    }
  }

  async function createServer(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!vault) return;
    const form = new FormData(event.currentTarget);
    const serverName = String(form.get('serverName') ?? '').trim();
    const displayName = String(form.get('displayName') ?? '').trim();
    const port = Number(form.get('port') ?? 9473);
    try {
      setError('');
      setStatus('Creating encrypted local server…');
      const key = await generateRoomKey();
      const encryptedRoomKey = await sealRoomKey(key, vault.identity.boxPublicKey);
      const info = await window.localium.server.create({
        serverName,
        displayName,
        port,
        ownerIdentity: vault.identity,
        encryptedRoomKey
      });
      const record: ServerKeyRecord = {
        endpoint: info.endpoint,
        fingerprint: info.fingerprint,
        roomKey: key,
        serverName: info.serverName
      };
      const nextVault = { ...vault, servers: { ...vault.servers, [info.serverId]: record } };
      await persistVault(nextVault);
      setHostedServers(await window.localium.server.listHosted());
      await window.localium.security.trustFingerprint(info.fingerprint);
      await connect(info.serverId, record);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to create server.');
      setStatus('Server creation failed.');
    }
  }

  async function joinServer(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!vault) return;
    const form = new FormData(event.currentTarget);
    const inviteCode = String(form.get('inviteCode') ?? '').trim();
    const displayName = String(form.get('displayName') ?? '').trim();
    try {
      setError('');
      const invite = decodeInvite(inviteCode);
      await window.localium.security.trustFingerprint(invite.fingerprint);
      const client = new LocaliumClient(invite.endpoint, vault.identity);
      clientRef.current?.close();
      clientRef.current = client;
      bindClientEvents(client);
      client.on('join.approved', (payload) => {
        const approval = payload as { pendingId: string; encryptedRoomKey: string };
        void (async () => {
          try {
            const key = await openSealedRoomKey(approval.encryptedRoomKey, vault.identity.boxPublicKey, vault.identity.boxPrivateKey);
            const record: ServerKeyRecord = {
              endpoint: invite.endpoint,
              fingerprint: invite.fingerprint,
              roomKey: key,
              serverName: invite.serverName
            };
            const nextVault = { ...vault, servers: { ...vault.servers, [invite.serverId]: record } };
            await persistVault(nextVault);
            client.close();
            setRoomKey(key);
            await connect(invite.serverId, record);
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Unable to activate membership.');
          }
        })();
      });
      client.on('join.rejected', () => {
        setError('A server administrator rejected this request.');
        setScreen('join');
      });
      setStatus(`Submitting an approval request to ${invite.serverName}…`);
      const id = await client.requestJoin(inviteCode, displayName);
      setPendingId(id);
      setScreen('pending');
      setStatus('Waiting for an owner or administrator to approve this device.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to request membership.');
      setStatus('Join request failed.');
    }
  }

  async function sendText(event: FormEvent): Promise<void> {
    event.preventDefault();
    const client = clientRef.current;
    if (!client || !roomKey || !messageText.trim()) return;
    const messageId = crypto.randomUUID();
    const text = messageText.trim();
    setMessageText('');
    try {
      let payload: DecryptedChatPayload = { kind: 'text', text };
      if (text.startsWith('/')) {
        const [commandToken, ...rest] = text.slice(1).split(/\s+/u);
        const result = await client.request<CommandExecutionResult>({
          type: 'command.execute',
          command: commandToken ?? '',
          args: rest.join(' ')
        });
        payload = { kind: 'system', text: result.text, command: result.command };
      }
      const envelope = await encryptJson<DecryptedChatPayload>(roomKey, payload, `message:${messageId}`);
      await client.request({ type: 'message.send', messageId, envelope });
      setCommandMenuOpen(false);
    } catch (caught) {
      setMessageText(text);
      setError(caught instanceof Error ? caught.message : 'Unable to send message.');
    }
  }

  async function sendFile(): Promise<void> {
    const client = clientRef.current;
    if (!client || !roomKey) return;
    try {
      const selected = await window.localium.dialog.openFile();
      if (!selected) return;
      const bytes = bytesFromBase64(selected.dataBase64);
      if (bytes.length > MAX_ASSET_BYTES) throw new Error(`Files are limited to ${formatBytes(MAX_ASSET_BYTES)}.`);
      setStatus(`Encrypting ${selected.name} locally…`);
      const messageId = crypto.randomUUID();
      const encrypted = await encryptBytes(roomKey, bytes, `asset:${messageId}`);
      const upload = await client.uploadAsset('attachment', encrypted);
      const envelope = await encryptJson<DecryptedChatPayload>(
        roomKey,
        {
          kind: 'file',
          assetId: upload.assetId,
          fileName: selected.name,
          mimeType: 'application/octet-stream',
          byteLength: bytes.length
        },
        `message:${messageId}`
      );
      await client.request({ type: 'message.send', messageId, envelope });
      setStatus('Encrypted file sent.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to send file.');
    }
  }

  async function downloadFile(message: DecryptedMessage): Promise<void> {
    const client = clientRef.current;
    const payload = message.payload;
    if (!client || !roomKey || !payload?.assetId || !payload.fileName) return;
    try {
      setStatus(`Downloading ${payload.fileName}…`);
      const encrypted = await client.downloadAsset(payload.assetId);
      const decrypted = await decryptBytes(roomKey, encrypted, `asset:${message.id}`);
      await window.localium.dialog.saveFile({ suggestedName: payload.fileName, dataBase64: base64FromBytes(decrypted) });
      setStatus('File decrypted and saved locally.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to download file.');
    }
  }

  async function sendSticker(sticker: StickerRecord): Promise<void> {
    const client = clientRef.current;
    if (!client || !roomKey) return;
    const messageId = crypto.randomUUID();
    try {
      const envelope = await encryptJson<DecryptedChatPayload>(
        roomKey,
        { kind: 'sticker', stickerId: sticker.id },
        `message:${messageId}`
      );
      await client.request({ type: 'message.send', messageId, envelope });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to send sticker.');
    }
  }

  async function createInvite(permanent: boolean): Promise<void> {
    const client = clientRef.current;
    if (!client) return;
    try {
      const result = await client.request<{ code: string; invite: Omit<InviteRecord, 'secretHash'> }>({
        type: 'invite.create',
        permanent,
        maxUses: null
      });
      setNewInviteCode(result.code);
      setSnapshot((current) => current ? { ...current, invites: upsert(current.invites, result.invite) } : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to create invitation.');
    }
  }

  async function revokeInvite(inviteId: string): Promise<void> {
    const client = clientRef.current;
    if (!client) return;
    try {
      await client.request({ type: 'invite.revoke', inviteId });
      setSnapshot((current) => current ? {
        ...current,
        invites: current.invites.map((invite) => invite.id === inviteId ? { ...invite, revokedAt: new Date().toISOString() } : invite)
      } : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to revoke invitation.');
    }
  }

  async function approvePending(pending: PendingJoinRecord): Promise<void> {
    const client = clientRef.current;
    if (!client || !roomKey) return;
    try {
      const encryptedRoomKey = await sealRoomKey(roomKey, pending.boxPublicKey);
      const member = await client.request<MemberRecord>({
        type: 'pending.approve',
        pendingId: pending.id,
        encryptedRoomKey,
        roleIds: ['member']
      });
      setSnapshot((current) => current ? {
        ...current,
        pending: current.pending.filter((entry) => entry.id !== pending.id),
        members: [...current.members.filter((entry) => entry.deviceId !== member.deviceId), member]
      } : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to approve member.');
    }
  }

  async function rejectPending(pendingIdValue: string): Promise<void> {
    const client = clientRef.current;
    if (!client) return;
    try {
      await client.request({ type: 'pending.reject', pendingId: pendingIdValue });
      setSnapshot((current) => current ? { ...current, pending: current.pending.filter((entry) => entry.id !== pendingIdValue) } : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to reject request.');
    }
  }

  async function updateMemberRole(member: MemberRecord, roleId: string): Promise<void> {
    const client = clientRef.current;
    if (!client) return;
    try {
      const updated = await client.request<MemberRecord>({ type: 'member.update', deviceId: member.deviceId, roleIds: [roleId] });
      setSnapshot((current) => current ? {
        ...current,
        members: current.members.map((entry) => entry.deviceId === updated.deviceId ? updated : entry)
      } : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to update member.');
    }
  }

  async function removeMember(deviceId: string): Promise<void> {
    const client = clientRef.current;
    if (!client) return;
    try {
      await client.request({ type: 'member.remove', deviceId });
      setSnapshot((current) => current ? { ...current, members: current.members.filter((entry) => entry.deviceId !== deviceId) } : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to remove member.');
    }
  }

  async function createRole(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const client = clientRef.current;
    if (!client) return;
    const form = new FormData(event.currentTarget);
    const selected = PERMISSIONS.filter((permission) => form.get(permission) === 'on');
    try {
      const role = await client.request<RoleRecord>({
        type: 'role.create',
        name: String(form.get('roleName') ?? ''),
        color: String(form.get('roleColor') ?? '#60a5fa'),
        permissions: selected
      });
      setSnapshot((current) => current ? { ...current, roles: [...current.roles, role] } : current);
      event.currentTarget.reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to create role.');
    }
  }

  async function uploadAvatar(): Promise<void> {
    const client = clientRef.current;
    if (!client || !roomKey || !snapshot) return;
    try {
      const selected = await window.localium.dialog.openImage();
      if (!selected) return;
      const bytes = bytesFromBase64(selected.dataBase64);
      if (bytes.length === 0) throw new Error('The selected avatar is empty.');
      if (bytes.length > 5 * 1024 * 1024) throw new Error('Avatar images are limited to 5 MiB.');
      const encrypted = await encryptBytes(roomKey, bytes, `avatar-asset:${snapshot.self.deviceId}`);
      const upload = await client.uploadAsset('avatar', encrypted);
      const updated = await client.request<MemberRecord>({ type: 'member.avatar', assetId: upload.assetId });
      setSnapshot((current) => current ? {
        ...current,
        self: updated,
        members: current.members.map((member) => member.deviceId === updated.deviceId ? updated : member)
      } : current);
      await loadAvatarAsset(client, roomKey, updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to update avatar.');
    }
  }

  async function clearAvatar(): Promise<void> {
    const client = clientRef.current;
    if (!client || !snapshot) return;
    try {
      const updated = await client.request<MemberRecord>({ type: 'member.avatar', assetId: null });
      setSnapshot((current) => current ? {
        ...current,
        self: updated,
        members: current.members.map((member) => member.deviceId === updated.deviceId ? updated : member)
      } : current);
      setAvatarUrls((current) => {
        if (current[updated.deviceId]) URL.revokeObjectURL(current[updated.deviceId]);
        const next = { ...current };
        delete next[updated.deviceId];
        return next;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to remove avatar.');
    }
  }

  async function reloadMods(): Promise<void> {
    const client = clientRef.current;
    if (!client) return;
    try {
      const commands = await client.request<CommandSummary[]>({ type: 'mods.reload' });
      setSnapshot((current) => current ? { ...current, commands } : current);
      setStatus(`Reloaded ${commands.length} available slash commands.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to reload mods.');
    }
  }

  async function uploadSticker(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const client = clientRef.current;
    if (!client || !roomKey) return;
    const form = new FormData(event.currentTarget);
    const label = String(form.get('stickerLabel') ?? '').trim();
    try {
      const selected = await window.localium.dialog.openImage();
      if (!selected) return;
      const bytes = bytesFromBase64(selected.dataBase64);
      if (bytes.length === 0) throw new Error('The selected sticker is empty.');
      if (bytes.length > 10 * 1024 * 1024) throw new Error('Sticker images are limited to 10 MiB.');
      const encrypted = await encryptBytes(roomKey, bytes, 'sticker-asset');
      const upload = await client.uploadAsset('sticker', encrypted);
      const sticker = await client.request<StickerRecord>({ type: 'sticker.create', label, assetId: upload.assetId });
      setSnapshot((current) => current ? { ...current, stickers: [...current.stickers, sticker] } : current);
      await loadStickerAsset(client, roomKey, sticker);
      event.currentTarget.reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to add sticker.');
    }
  }

  async function updateServer(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const client = clientRef.current;
    if (!client) return;
    const form = new FormData(event.currentTarget);
    try {
      const settings = await client.request<AuthenticatedSnapshot['settings']>({
        type: 'server.update',
        name: String(form.get('serverName') ?? '')
      });
      setSnapshot((current) => current ? { ...current, settings } : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to update server.');
    }
  }

  async function uploadBackground(): Promise<void> {
    const client = clientRef.current;
    if (!client || !roomKey) return;
    try {
      const selected = await window.localium.dialog.openImage();
      if (!selected) return;
      const bytes = bytesFromBase64(selected.dataBase64);
      if (bytes.length === 0) throw new Error('The selected background is empty.');
      if (bytes.length > 15 * 1024 * 1024) throw new Error('Background images are limited to 15 MiB.');
      const encrypted = await encryptBytes(roomKey, bytes, 'background-asset');
      const upload = await client.uploadAsset('background', encrypted);
      const settings = await client.request<AuthenticatedSnapshot['settings']>({ type: 'server.update', backgroundAssetId: upload.assetId });
      setSnapshot((current) => current ? { ...current, settings } : current);
      await loadVisualAssets(client, roomKey, { ...snapshot!, settings });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to update background.');
    }
  }

  async function deleteRole(roleId: string): Promise<void> {
    const client = clientRef.current;
    if (!client) return;
    try {
      await client.request({ type: 'role.delete', roleId });
      setSnapshot((current) => current ? {
        ...current,
        roles: current.roles.filter((role) => role.id !== roleId),
        members: current.members.map((member) => ({
          ...member,
          roleIds: member.roleIds.filter((id) => id !== roleId).length > 0
            ? member.roleIds.filter((id) => id !== roleId)
            : ['member']
        }))
      } : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to delete role.');
    }
  }

  async function deleteSticker(stickerId: string): Promise<void> {
    const client = clientRef.current;
    if (!client) return;
    try {
      await client.request({ type: 'sticker.delete', stickerId });
      setSnapshot((current) => current ? { ...current, stickers: current.stickers.filter((sticker) => sticker.id !== stickerId) } : current);
      setStickerUrls((current) => {
        if (current[stickerId]) URL.revokeObjectURL(current[stickerId]);
        const next = { ...current };
        delete next[stickerId];
        return next;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to delete sticker.');
    }
  }

  async function clearBackground(): Promise<void> {
    const client = clientRef.current;
    if (!client) return;
    try {
      const settings = await client.request<AuthenticatedSnapshot['settings']>({ type: 'server.update', backgroundAssetId: null });
      setSnapshot((current) => current ? { ...current, settings } : current);
      setBackgroundUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to clear background.');
    }
  }

  async function showDebugLogs(): Promise<void> {
    setDebugLogs(await window.localium.debug.readLogs());
    setDebugOpen(true);
  }

  function leaveChat(): void {
    clientRef.current?.close();
    clientRef.current = null;
    setSnapshot(null);
    setRoomKey(null);
    setMessages([]);
    setBackgroundUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setStickerUrls((current) => {
      for (const url of Object.values(current)) URL.revokeObjectURL(url);
      return {};
    });
    setAvatarUrls((current) => {
      for (const url of Object.values(current)) URL.revokeObjectURL(url);
      return {};
    });
    setAdminOpen(false);
    setScreen('landing');
    setStatus('Disconnected.');
  }

  const savedServers = vault ? Object.entries(vault.servers) : [];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">L</span><span>Localium</span></div>
        <div className="status-line"><span className="status-dot" />{status}</div>
        <span className="runtime-pill">{platform === 'android' ? 'Android client' : 'Desktop'}</span>
        {platform === 'desktop' && <button className="ghost-button" onClick={() => void showDebugLogs()}>Debug log</button>}
      </header>

      {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}

      {screen === 'landing' && (
        <main className="landing">
          <section className="hero-card">
            <div>
              <p className="eyebrow">PRIVATE INFRASTRUCTURE</p>
              <h1>Messages and files stay on infrastructure you control.</h1>
              <p className="hero-copy">Create a local server, approve every device, and exchange end-to-end encrypted messages, stickers, and files without routing content through a third-party chat provider.</p>
              <div className="hero-actions">
                {platform === 'desktop' && <button className="primary-button" onClick={() => setScreen('create')}>Create server</button>}
                <button className={platform === 'android' ? 'primary-button' : 'secondary-button'} onClick={() => setScreen('join')}>Join with invitation</button>
              </div>
            </div>
            <div className="security-card">
              <div className="lock-orbit"><span>🔐</span></div>
              <strong>Zero-knowledge message storage</strong>
              <p>XChaCha20-Poly1305 content encryption, Ed25519 device signatures, X25519 key delivery, pinned TLS, and explicit administrator approval.</p>
            </div>
          </section>

          <section className="saved-section">
            <div className="section-heading"><h2>Saved servers</h2><span>{savedServers.length}</span></div>
            {savedServers.length === 0 ? (
              <div className="empty-state">No approved servers are stored on this device.</div>
            ) : (
              <div className="server-grid">
                {savedServers.map(([serverId, server]) => {
                  const hosted = hostedServers.some((entry) => entry.serverId === serverId);
                  return (
                    <button className="server-card" key={serverId} onClick={() => void openSavedServer(serverId)}>
                      <span className="server-icon">{server.serverName.slice(0, 1).toUpperCase()}</span>
                      <span><strong>{server.serverName}</strong><small>{hosted ? 'Hosted on this device' : 'Remote private server'}</small></span>
                      <span className="arrow">→</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </main>
      )}

      {screen === 'create' && (
        <main className="form-page">
          <form className="panel form-card" onSubmit={(event: FormEvent<HTMLFormElement>) => void createServer(event)}>
            <button type="button" className="back-link" onClick={() => setScreen('landing')}>← Back</button>
            <p className="eyebrow">NEW PRIVATE SERVER</p>
            <h1>Create a Localium server</h1>
            <label>Server name<input name="serverName" required minLength={1} maxLength={80} placeholder="Research Department" /></label>
            <label>Your display name<input name="displayName" required minLength={1} maxLength={64} placeholder="Alex" /></label>
            <label>Listening port<input name="port" type="number" defaultValue={9473} min={1} max={65535} required /></label>
            <div className="notice">The server listens on the local network. Remote access requires a VPN or firewall configuration under your control.</div>
            <button className="primary-button" type="submit">Create and open</button>
          </form>
        </main>
      )}

      {screen === 'join' && (
        <main className="form-page">
          <form className="panel form-card wide" onSubmit={(event: FormEvent<HTMLFormElement>) => void joinServer(event)}>
            <button type="button" className="back-link" onClick={() => setScreen('landing')}>← Back</button>
            <p className="eyebrow">DEVICE APPROVAL REQUIRED</p>
            <h1>Join a private server</h1>
            <label>Your display name<input name="displayName" required minLength={1} maxLength={64} placeholder="Alex" /></label>
            <label>Invitation code<textarea name="inviteCode" required rows={6} placeholder="LOCALIUM1.…" /></label>
            <div className="notice">The invitation pins the server certificate. Localium will reject a server whose identity does not match the invitation.</div>
            <button className="primary-button" type="submit">Request access</button>
          </form>
        </main>
      )}

      {screen === 'pending' && (
        <main className="form-page">
          <section className="panel pending-card">
            <div className="pending-spinner" />
            <p className="eyebrow">AWAITING APPROVAL</p>
            <h1>An administrator must approve this device.</h1>
            <p>Keep this window open. No server messages or files can be accessed until approval and encrypted key delivery are complete.</p>
            <code>{pendingId}</code>
            <button className="secondary-button" onClick={() => { clientRef.current?.close(); setScreen('landing'); }}>Cancel request</button>
          </section>
        </main>
      )}

      {screen === 'chat' && snapshot && roomKey && (
        <main className="chat-layout" style={backgroundUrl ? { backgroundImage: `linear-gradient(rgba(7, 10, 20, .86), rgba(7, 10, 20, .93)), url(${backgroundUrl})` } : undefined}>
          <aside className="server-sidebar">
            <div className="server-title"><span className="server-icon">{snapshot.settings.name.slice(0, 1).toUpperCase()}</span><div><strong>{snapshot.settings.name}</strong><small>{snapshot.members.length} approved members</small></div></div>
            <nav>
              <button className="nav-button active"># General</button>
              <button className="nav-button" onClick={() => setAdminOpen((value) => !value)}>⚙ Administration</button>
            </nav>
            <div className="member-list">
              <h3>Members</h3>
              {snapshot.members.map((member) => (
                <div className="member-row" key={member.deviceId}><MemberAvatar member={member} url={avatarUrls[member.deviceId]} /><span><strong>{member.displayName}</strong><small>{member.roleIds.map((roleId) => snapshot.roles.find((role) => role.id === roleId)?.name).filter(Boolean).join(', ')}</small></span></div>
              ))}
            </div>
            <div className="profile-card"><MemberAvatar member={snapshot.self} url={avatarUrls[snapshot.self.deviceId]} large /><div><strong>{snapshot.self.displayName}</strong><small>Encrypted device profile</small></div><button onClick={() => void uploadAvatar()}>Change avatar</button>{snapshot.self.avatarAssetId && <button className="text-danger" onClick={() => void clearAvatar()}>Remove</button>}</div>
            <button className="danger-button" onClick={leaveChat}>Disconnect</button>
          </aside>

          <section className="conversation">
            <div className="conversation-header"><div><h2># General</h2><p>Encrypted on your device before transmission</p></div><span className="secure-pill">E2EE active</span></div>
            <div className="message-list">
              {messages.length === 0 && <div className="empty-chat"><strong>This encrypted room is ready.</strong><span>Send the first message or private file.</span></div>}
              {messages.map((message) => {
                const sticker = message.payload?.stickerId ? snapshot.stickers.find((entry) => entry.id === message.payload?.stickerId) : null;
                return (
                  <article className="message" key={message.id}>
                    {(() => { const member = snapshot.members.find((entry) => entry.deviceId === message.senderDeviceId); return member ? <MemberAvatar member={member} url={avatarUrls[member.deviceId]} /> : <span className="avatar">?</span>; })()}
                    <div className="message-body">
                      <div className="message-meta"><strong>{memberName(snapshot, message.senderDeviceId)}</strong><time>{formatDate(message.createdAt)}</time></div>
                      {message.failed && <div className="decrypt-failed">Unable to decrypt this record.</div>}
                      {message.payload?.kind === 'text' && <p>{message.payload.text}</p>}
                      {message.payload?.kind === 'system' && <div className="command-result"><strong>/{message.payload.command ?? 'command'}</strong><p>{message.payload.text}</p></div>}
                      {message.payload?.kind === 'file' && (
                        <button className="file-card" onClick={() => void downloadFile(message)}>
                          <span>📄</span><span><strong>{message.payload.fileName}</strong><small>{formatBytes(message.payload.byteLength)} · decrypt on download</small></span><span>Download</span>
                        </button>
                      )}
                      {message.payload?.kind === 'sticker' && sticker && (
                        <div className="sticker-message">
                          {sticker.builtInEmoji ? <span>{sticker.builtInEmoji}</span> : stickerUrls[sticker.id] ? <img src={stickerUrls[sticker.id]} alt={sticker.label} /> : <span>🖼️</span>}
                          <small>{sticker.label}</small>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="sticker-strip">
              {snapshot.stickers.map((sticker) => (
                <button title={sticker.label} key={sticker.id} onClick={() => void sendSticker(sticker)}>
                  {sticker.builtInEmoji ?? (stickerUrls[sticker.id] ? <img src={stickerUrls[sticker.id]} alt={sticker.label} /> : '🖼️')}
                </button>
              ))}
            </div>
            {(commandMenuOpen || messageText.startsWith('/')) && commandSuggestions.length > 0 && <div className="command-palette">{commandSuggestions.map((command) => <button key={`${command.moduleId}:${command.name}`} onClick={() => { setMessageText(`/${command.name} `); setCommandMenuOpen(false); }}><strong>/{command.name}</strong><span>{command.description}</span>{command.permission && <small>{command.permission.replaceAll('_', ' ')}</small>}</button>)}</div>}
            <form className="composer" onSubmit={(event: FormEvent<HTMLFormElement>) => void sendText(event)}>
              <button type="button" title="Send encrypted file" onClick={() => void sendFile()}>＋</button>
              <button type="button" title="Slash commands" onClick={() => { setMessageText((value) => value.startsWith('/') ? value : '/'); setCommandMenuOpen(true); }}>/</button>
              <input value={messageText} onChange={(event: ChangeEvent<HTMLInputElement>) => { setMessageText(event.target.value); setCommandMenuOpen(event.target.value.startsWith('/')); }} maxLength={4000} placeholder={`Message # General or type / for commands`} />
              <button type="submit" className="send-button">Send</button>
            </form>
          </section>

          {adminOpen && (
            <aside className="admin-panel">
              <div className="admin-header"><div><p className="eyebrow">SERVER CONTROL</p><h2>Administration</h2></div><button onClick={() => setAdminOpen(false)}>×</button></div>

              {permissions.has('approve_members') && (
                <section className="admin-section">
                  <h3>Pending approvals <span>{snapshot.pending.length}</span></h3>
                  {snapshot.pending.length === 0 ? <p className="muted">No devices are waiting.</p> : snapshot.pending.map((pending) => (
                    <div className="admin-item" key={pending.id}><div><strong>{pending.displayName}</strong><small>{formatDate(pending.requestedAt)}</small></div><div><button onClick={() => void approvePending(pending)}>Approve</button><button className="text-danger" onClick={() => void rejectPending(pending.id)}>Reject</button></div></div>
                  ))}
                </section>
              )}

              {permissions.has('manage_invites') && (
                <section className="admin-section">
                  <h3>Invitations</h3>
                  <div className="button-row"><button onClick={() => void createInvite(false)}>Create 15-minute code</button><button onClick={() => void createInvite(true)}>Create permanent code</button></div>
                  {newInviteCode && <div className="invite-code"><textarea readOnly value={newInviteCode} /><button onClick={() => void navigator.clipboard.writeText(newInviteCode)}>Copy</button></div>}
                  <div className="mini-list">{snapshot.invites.map((invite) => <div key={invite.id}><span>{invite.revokedAt ? 'Revoked' : invite.expiresAt ? `Expires ${formatDate(invite.expiresAt)}` : 'Permanent'}</span><small>{invite.useCount} uses</small>{!invite.revokedAt && <button className="text-danger" onClick={() => void revokeInvite(invite.id)}>Revoke</button>}</div>)}</div>
                </section>
              )}

              {permissions.has('manage_members') && (
                <section className="admin-section">
                  <h3>Members</h3>
                  {snapshot.members.map((member) => (
                    <div className="admin-item stacked" key={member.deviceId}><div><strong>{member.displayName}</strong><small>{member.deviceId.slice(0, 14)}…</small></div>{member.deviceId !== snapshot.ownerDeviceId && member.deviceId !== snapshot.self.deviceId && <div><select value={member.roleIds[0] ?? 'member'} onChange={(event: ChangeEvent<HTMLSelectElement>) => void updateMemberRole(member, event.target.value)}>{snapshot.roles.filter((role) => role.id !== 'owner').map((role) => <option value={role.id} key={role.id}>{role.name}</option>)}</select><button className="text-danger" onClick={() => void removeMember(member.deviceId)}>Remove</button></div>}</div>
                  ))}
                </section>
              )}

              {permissions.has('manage_roles') && (
                <section className="admin-section">
                  <h3>Custom role</h3>
                  <form onSubmit={(event: FormEvent<HTMLFormElement>) => void createRole(event)} className="compact-form">
                    <input name="roleName" required placeholder="Document reviewer" />
                    <input name="roleColor" type="color" defaultValue="#60a5fa" />
                    <div className="permission-grid">{PERMISSIONS.map((permission) => <label key={permission}><input type="checkbox" name={permission} />{permission.replaceAll('_', ' ')}</label>)}</div>
                    <button type="submit">Create role</button>
                  </form>
                  <div className="mini-list">{snapshot.roles.filter((role) => !role.system).map((role) => <div key={role.id}><span>{role.name}</span><small>{role.permissions.length} permissions</small><button className="text-danger" onClick={() => void deleteRole(role.id)}>Delete</button></div>)}</div>
                </section>
              )}

              {permissions.has('manage_server') && (
                <section className="admin-section">
                  <h3>Appearance</h3>
                  <form className="compact-form inline" onSubmit={(event: FormEvent<HTMLFormElement>) => void updateServer(event)}><input name="serverName" defaultValue={snapshot.settings.name} required /><button type="submit">Rename</button></form>
                  <div className="button-row"><button onClick={() => void uploadBackground()}>Upload encrypted background</button>{snapshot.settings.backgroundAssetId && <button className="text-danger" onClick={() => void clearBackground()}>Clear background</button>}</div>
                </section>
              )}

              {permissions.has('manage_stickers') && (
                <section className="admin-section">
                  <h3>Custom sticker</h3>
                  <form className="compact-form inline" onSubmit={(event: FormEvent<HTMLFormElement>) => void uploadSticker(event)}><input name="stickerLabel" required placeholder="Sticker label" /><button type="submit">Choose image</button></form>
                  <div className="mini-list">{snapshot.stickers.filter((sticker) => !sticker.builtInEmoji).map((sticker) => <div key={sticker.id}><span>{sticker.label}</span><button className="text-danger" onClick={() => void deleteSticker(sticker.id)}>Delete</button></div>)}</div>
                </section>
              )}

              {permissions.has('manage_mods') && (
                <section className="admin-section">
                  <h3>Server mods</h3>
                  <p className="muted">Edit JSON modules in the hosted server's <code>mods</code> directory, then reload. Modules are declarative and cannot execute JavaScript.</p>
                  <button onClick={() => void reloadMods()}>Reload mods</button>
                  <div className="mini-list">{snapshot.commands.map((command) => <div key={`${command.moduleId}:${command.name}`}><span>/{command.name}</span><small>{command.moduleId}{command.permission ? ` · ${command.permission}` : ''}</small></div>)}</div>
                </section>
              )}

              {permissions.has('view_audit') && (
                <section className="admin-section">
                  <h3>Recent audit events</h3>
                  <div className="audit-list">{snapshot.audit.slice(0, 20).map((entry) => <div key={entry.id}><strong>{entry.action}</strong><small>{formatDate(entry.createdAt)}</small></div>)}</div>
                </section>
              )}
            </aside>
          )}
        </main>
      )}

      {debugOpen && (
        <div className="modal-backdrop" onClick={() => setDebugOpen(false)}>
          <section className="debug-modal" onClick={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}>
            <div><h2>Debug log</h2><button onClick={() => setDebugOpen(false)}>×</button></div>
            <pre>{debugLogs || 'No server log entries are available. Start with LOCALIUM_DEBUG=1 for informational events.'}</pre>
          </section>
        </div>
      )}
    </div>
  );
}
