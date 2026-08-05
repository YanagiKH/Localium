import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModRegistry } from '../src/main/mods.js';
import type { Permission } from '../src/shared/constants.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function registryWithModule(module: unknown): Promise<ModRegistry> {
  const directory = await mkdtemp(path.join(tmpdir(), 'localium-mods-'));
  directories.push(directory);
  await writeFile(path.join(directory, 'module.json'), JSON.stringify(module), 'utf8');
  return ModRegistry.open(directory);
}

describe('ModRegistry', () => {
  it('executes a permission-limited data-only slash command', async () => {
    const registry = await registryWithModule({
      id: 'school.tools', name: 'School tools', enabled: true,
      commands: [{ name: 'welcome', description: 'Welcome a member', permission: 'send_messages', response: 'Welcome {{arg0}} to {{server}} — {{user}}' }]
    });
    const result = registry.execute('welcome', 'Mina', { displayName: 'Alex', serverName: 'Lab' }, new Set<Permission>(['send_messages']));
    expect(result.text).toBe('Welcome Mina to Lab — Alex');
    expect(result.visibility).toBe('channel');
  });

  it('does not expose commands without the configured permission', async () => {
    const registry = await registryWithModule({
      id: 'admin.tools', name: 'Admin tools', enabled: true,
      commands: [{ name: 'notice', description: 'Post a notice', permission: 'manage_server', response: 'Notice' }]
    });
    expect(registry.list(new Set<Permission>())).not.toContainEqual(expect.objectContaining({ name: 'notice' }));
    expect(() => registry.execute('notice', '', { displayName: 'A', serverName: 'S' }, new Set<Permission>())).toThrow('Missing permission');
  });

  it('rejects duplicate command names across modules', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'localium-mods-'));
    directories.push(directory);
    const command = { name: 'same', description: 'Same', permission: null, response: 'ok' };
    await writeFile(path.join(directory, 'a.json'), JSON.stringify({ id: 'a', name: 'A', enabled: true, commands: [command] }), 'utf8');
    await writeFile(path.join(directory, 'b.json'), JSON.stringify({ id: 'b', name: 'B', enabled: true, commands: [command] }), 'utf8');
    await expect(ModRegistry.open(directory)).rejects.toThrow('Duplicate slash command');
  });
});
