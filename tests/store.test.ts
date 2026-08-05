import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ServerStore } from '../src/main/store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStore(): Promise<ServerStore> {
  const directory = await mkdtemp(path.join(tmpdir(), 'localium-store-'));
  directories.push(directory);
  return ServerStore.openOrCreate(directory, {
    serverId: '76818a7d-bbdf-43ca-bc1d-a31a117b0ee0',
    serverName: 'Test Server',
    owner: {
      deviceId: 'owner-device',
      displayName: 'Owner',
      signPublicKey: 'sign-public-key',
      boxPublicKey: 'box-public-key',
      roleIds: ['owner'],
      encryptedRoomKey: 'sealed-room-key'
    }
  });
}

describe('server store', () => {
  it('creates owner roles and built-in stickers', async () => {
    const store = await createStore();
    const state = store.snapshot();
    expect(state.settings.name).toBe('Test Server');
    expect(state.members['owner-device'].roleIds).toEqual(['owner']);
    expect(state.roles.owner.permissions).toContain('manage_server');
    expect(Object.keys(state.stickers).length).toBeGreaterThanOrEqual(6);
  });

  it('serializes concurrent transactions and persists atomically', async () => {
    const store = await createStore();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.transaction((draft) => {
        draft.audit.push({
          id: `audit-${index}`,
          actorDeviceId: 'owner-device',
          action: 'test.concurrent',
          targetId: null,
          createdAt: new Date().toISOString(),
          detail: { index }
        });
      }))
    );
    expect(store.snapshot().audit).toHaveLength(20);
    const statePath = path.join(store.dataDir, 'server-state.json');
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { audit: unknown[] };
    expect(persisted.audit).toHaveLength(20);
  });
});
