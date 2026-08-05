import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Permission } from '../shared/constants.js';
import { PERMISSIONS } from '../shared/constants.js';
import type { CommandExecutionResult, CommandSummary } from '../shared/types.js';

interface ModCommandConfig {
  name: string;
  description: string;
  permission: Permission | null;
  response: string;
}

interface ModModuleConfig {
  id: string;
  name: string;
  enabled: boolean;
  commands: ModCommandConfig[];
}

interface CommandContext {
  displayName: string;
  serverName: string;
}

const COMMAND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const MAX_MOD_FILE_BYTES = 128 * 1024;
const MAX_MOD_FILES = 128;
const MAX_TOTAL_COMMANDS = 1_000;
const MAX_COMMAND_RESPONSE = 2_000;

function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

function cleanText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max) throw new Error(`${field} must contain 1-${max} characters.`);
  return cleaned;
}

function parseModule(raw: unknown, fileName: string): ModModuleConfig {
  if (!raw || typeof raw !== 'object') throw new Error(`${fileName}: module must be an object.`);
  const value = raw as Record<string, unknown>;
  const id = cleanText(value.id, 'id', 64);
  const name = cleanText(value.name, 'name', 80);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id)) throw new Error(`${fileName}: invalid module id.`);
  const enabled = value.enabled !== false;
  if (!Array.isArray(value.commands) || value.commands.length > 100) throw new Error(`${fileName}: commands must be an array of at most 100 entries.`);
  const commands = value.commands.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`${fileName}: command ${index + 1} must be an object.`);
    const command = entry as Record<string, unknown>;
    const commandName = cleanText(command.name, 'command name', 32).toLowerCase();
    if (!COMMAND_PATTERN.test(commandName)) throw new Error(`${fileName}: invalid command name: ${commandName}.`);
    const permission = command.permission === null || command.permission === undefined
      ? null
      : isPermission(command.permission) ? command.permission : (() => { throw new Error(`${fileName}: invalid permission for /${commandName}.`); })();
    return {
      name: commandName,
      description: cleanText(command.description, 'command description', 180),
      permission,
      response: cleanText(command.response, 'command response', MAX_COMMAND_RESPONSE)
    } satisfies ModCommandConfig;
  });
  return { id, name, enabled, commands };
}

function renderTemplate(template: string, args: string, context: CommandContext): string {
  const words = args.trim().split(/\s+/u).filter(Boolean);
  return template
    .replaceAll('{{args}}', args.trim())
    .replaceAll('{{user}}', context.displayName)
    .replaceAll('{{server}}', context.serverName)
    .replace(/\{\{arg(\d+)\}\}/gu, (_match, index: string) => words[Number(index)] ?? '')
    .slice(0, MAX_COMMAND_RESPONSE);
}

export class ModRegistry {
  private readonly directory: string;
  private modules: ModModuleConfig[] = [];
  private commands = new Map<string, { module: ModModuleConfig; command: ModCommandConfig }>();

  private constructor(directory: string) {
    this.directory = directory;
  }

  static async open(directory: string): Promise<ModRegistry> {
    const registry = new ModRegistry(directory);
    await registry.ensureFiles();
    await registry.reload();
    return registry;
  }

  async reload(): Promise<void> {
    const files = (await readdir(this.directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
    if (files.length > MAX_MOD_FILES) throw new Error(`Mods directory exceeds ${MAX_MOD_FILES} JSON files.`);
    const modules: ModModuleConfig[] = [];
    const commands = new Map<string, { module: ModModuleConfig; command: ModCommandConfig }>();
    for (const fileName of files) {
      const filePath = path.join(this.directory, fileName);
      const raw = await readFile(filePath, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > MAX_MOD_FILE_BYTES) throw new Error(`${fileName}: mod file exceeds 128 KiB.`);
      const module = parseModule(JSON.parse(raw) as unknown, fileName);
      if (!module.enabled) continue;
      for (const command of module.commands) {
        if (commands.has(command.name)) throw new Error(`Duplicate slash command: /${command.name}.`);
        if (commands.size >= MAX_TOTAL_COMMANDS) throw new Error(`Enabled mods exceed ${MAX_TOTAL_COMMANDS} slash commands.`);
        commands.set(command.name, { module, command });
      }
      modules.push(module);
    }
    this.modules = modules;
    this.commands = commands;
  }

  list(permissions: ReadonlySet<Permission>): CommandSummary[] {
    const result: CommandSummary[] = [{
      name: 'help',
      description: 'List slash commands available to your role.',
      permission: null,
      moduleId: 'localium.core'
    }];
    for (const { module, command } of this.commands.values()) {
      if (command.permission && !permissions.has(command.permission)) continue;
      result.push({ name: command.name, description: command.description, permission: command.permission, moduleId: module.id });
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  execute(commandName: string, args: string, context: CommandContext, permissions: ReadonlySet<Permission>): CommandExecutionResult {
    const normalized = commandName.trim().replace(/^\//u, '').toLowerCase();
    if (!COMMAND_PATTERN.test(normalized)) throw new Error('Invalid slash command.');
    if (args.length > 500) throw new Error('Slash command arguments are limited to 500 characters.');
    if (normalized === 'help') {
      const commands = this.list(permissions).map((command) => `/${command.name} — ${command.description}`).join('\n');
      return { command: 'help', text: commands, moduleId: 'localium.core', visibility: 'channel' };
    }
    const found = this.commands.get(normalized);
    if (!found) throw new Error(`Unknown slash command: /${normalized}.`);
    if (found.command.permission && !permissions.has(found.command.permission)) {
      throw new Error(`Missing permission: ${found.command.permission}`);
    }
    return {
      command: normalized,
      text: renderTemplate(found.command.response, args, context),
      moduleId: found.module.id,
      visibility: 'channel'
    };
  }

  private async ensureFiles(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const guide = `# Localium data-only mods\n\nEach .json file defines safe, declarative slash commands. Localium does not execute JavaScript from this directory.\n\nFields: id, name, enabled, commands[]. Each command supports name, description, optional permission, and response. Templates: {{user}}, {{server}}, {{args}}, {{arg0}}.\n`;
    const guidePath = path.join(this.directory, 'README.md');
    try {
      await readFile(guidePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFile(guidePath, guide, { encoding: 'utf8', mode: 0o600 });
    }
    const examplePath = path.join(this.directory, 'example-welcome.json');
    try {
      await readFile(examplePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFile(examplePath, JSON.stringify({
        id: 'example.welcome',
        name: 'Welcome commands',
        enabled: false,
        commands: [{
          name: 'welcome',
          description: 'Post the configured organization welcome message.',
          permission: 'send_messages',
          response: 'Welcome {{args}} to {{server}}. — {{user}}'
        }]
      }, null, 2), { encoding: 'utf8', mode: 0o600 });
    }
  }
}
