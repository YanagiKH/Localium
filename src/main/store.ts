import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_ASSET_BYTES, MAX_HISTORY_MESSAGES, PERMISSIONS } from '../shared/constants.js';
import type {
  AuditRecord,
  MemberRecord,
  PersistedServerState,
  RoleRecord,
  StickerRecord
} from '../shared/types.js';

export interface BootstrapServerInput {
  serverId: string;
  serverName: string;
  owner: Omit<MemberRecord, 'approvedAt' | 'lastSeenAt' | 'revokedAt'>;
}

function now(): string {
  return new Date().toISOString();
}

function defaultRoles(): Record<string, RoleRecord> {
  return {
    owner: {
      id: 'owner',
      name: 'Owner',
      color: '#8b5cf6',
      permissions: [...PERMISSIONS],
      system: true
    },
    administrator: {
      id: 'administrator',
      name: 'Administrator',
      color: '#22c55e',
      permissions: [...PERMISSIONS],
      system: true
    },
    member: {
      id: 'member',
      name: 'Member',
      color: '#60a5fa',
      permissions: ['send_messages', 'send_files'],
      system: true
    }
  };
}

function defaultStickers(ownerDeviceId: string): Record<string, StickerRecord> {
  const createdAt = now();
  const entries: Array<[string, string, string]> = [
    ['builtin-wave', 'Wave', '👋'],
    ['builtin-thanks', 'Thanks', '🙏'],
    ['builtin-ok', 'OK', '👌'],
    ['builtin-celebrate', 'Celebrate', '🎉'],
    ['builtin-focus', 'Focus', '🧠'],
    ['builtin-secure', 'Secure', '🔐']
  ];
  return Object.fromEntries(
    entries.map(([id, label, builtInEmoji]) => [
      id,
      { id, label, assetId: null, builtInEmoji, createdBy: ownerDeviceId, createdAt }
    ])
  );
}

function buildInitialState(input: BootstrapServerInput): PersistedServerState {
  const timestamp = now();
  const owner: MemberRecord = {
    ...input.owner,
    avatarAssetId: input.owner.avatarAssetId ?? null,
    roleIds: ['owner'],
    approvedAt: timestamp,
    lastSeenAt: timestamp,
    revokedAt: null
  };
  return {
    schemaVersion: 1,
    serverId: input.serverId,
    createdAt: timestamp,
    ownerDeviceId: owner.deviceId,
    settings: {
      name: input.serverName,
      backgroundAssetId: null,
      maxAssetBytes: MAX_ASSET_BYTES,
      approvalRequired: true
    },
    members: { [owner.deviceId]: owner },
    pending: {},
    invites: {},
    roles: defaultRoles(),
    messages: [],
    stickers: defaultStickers(owner.deviceId),
    assets: {},
    audit: []
  };
}

export class ServerStore {
  readonly dataDir: string;
  readonly statePath: string;
  readonly assetDir: string;
  private state: PersistedServerState;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(dataDir: string, state: PersistedServerState) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, 'server-state.json');
    this.assetDir = path.join(dataDir, 'assets');
    this.state = state;
  }

  static async openOrCreate(dataDir: string, bootstrap?: BootstrapServerInput): Promise<ServerStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await mkdir(path.join(dataDir, 'assets'), { recursive: true, mode: 0o700 });
    const statePath = path.join(dataDir, 'server-state.json');
    let state: PersistedServerState;
    try {
      const raw = await readFile(statePath, 'utf8');
      state = JSON.parse(raw) as PersistedServerState;
      if (state.schemaVersion !== 1) throw new Error('Unsupported server state schema.');
      for (const member of Object.values(state.members)) member.avatarAssetId ??= null;
      for (const roleId of ['owner', 'administrator']) {
        const role = state.roles[roleId];
        if (role) role.permissions = [...new Set([...role.permissions, ...PERMISSIONS])];
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      if (!bootstrap) throw new Error('Server data does not exist and no bootstrap owner was supplied.');
      state = buildInitialState(bootstrap);
      await writeFile(statePath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    }
    return new ServerStore(dataDir, state);
  }

  snapshot(): PersistedServerState {
    return structuredClone(this.state);
  }

  async transaction<T>(mutator: (draft: PersistedServerState) => T | Promise<T>): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.writeQueue = this.writeQueue.then(async () => {
      const draft = structuredClone(this.state);
      try {
        const value = await mutator(draft);
        if (draft.messages.length > MAX_HISTORY_MESSAGES) {
          draft.messages = draft.messages.slice(-MAX_HISTORY_MESSAGES);
        }
        if (draft.audit.length > 2_000) {
          draft.audit = draft.audit.slice(-2_000);
        }
        const temporary = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temporary, JSON.stringify(draft, null, 2), { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, this.statePath);
        this.state = draft;
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    });

    return result;
  }

  assetPath(assetId: string): string {
    if (!/^[a-f0-9-]{36}$/u.test(assetId)) throw new Error('Invalid asset id.');
    return path.join(this.assetDir, `${assetId}.bin`);
  }

  async appendAudit(
    actorDeviceId: string,
    action: string,
    targetId: string | null,
    detail: AuditRecord['detail'] = {}
  ): Promise<AuditRecord> {
    return this.transaction((draft) => {
      const record: AuditRecord = {
        id: randomUUID(),
        actorDeviceId,
        action,
        targetId,
        createdAt: now(),
        detail
      };
      draft.audit.push(record);
      return record;
    });
  }
}
