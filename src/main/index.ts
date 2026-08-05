import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { randomUUID, X509Certificate } from 'node:crypto';
import type { VaultData } from '../shared/types.js';
import type { CreateServerInput, HostedServerSummary, LocaliumServerInfo } from '../shared/desktop-api.js';
import { DEFAULT_PORT } from '../shared/constants.js';
import { normalizeFingerprint } from './security.js';
import { LocaliumServer } from './server.js';

let mainWindow: BrowserWindow | null = null;
let activeServer: LocaliumServer | null = null;
const trustedFingerprints = new Set<string>();

function userDataPath(...parts: string[]): string {
  return path.join(app.getPath('userData'), ...parts);
}

function pickAdvertisedHost(): string {
  const configured = process.env.LOCALIUM_ADVERTISED_HOST?.trim();
  if (configured) {
    if (!/^[a-zA-Z0-9.-]+$/u.test(configured)) throw new Error('LOCALIUM_ADVERTISED_HOST contains invalid characters.');
    return configured;
  }
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) return entry.address;
    }
  }
  return '127.0.0.1';
}

function validPort(value: unknown): number {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  return port;
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#090d18',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) await mainWindow.loadURL(devServerUrl);
  else await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
}

function requireSafeStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secure storage is unavailable. Unlock the system keychain and restart Localium.');
  }
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    throw new Error('Linux secure storage is using the insecure basic_text backend. Install and unlock GNOME Keyring or KWallet, then restart Localium.');
  }
}

async function loadVault(): Promise<VaultData | null> {
  const vaultPath = userDataPath('client-vault.bin');
  try {
    requireSafeStorage();
    const encrypted = await readFile(vaultPath);
    return JSON.parse(safeStorage.decryptString(encrypted)) as VaultData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function saveVault(vault: VaultData): Promise<void> {
  requireSafeStorage();
  await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
  const encrypted = safeStorage.encryptString(JSON.stringify(vault));
  await writeFile(userDataPath('client-vault.bin'), encrypted, { mode: 0o600 });
}

async function writeHostConfig(serverId: string, port: number): Promise<void> {
  const directory = userDataPath('servers', serverId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, 'host-config.json'), JSON.stringify({ port }, null, 2), { mode: 0o600 });
}

async function startServer(serverId: string, port: number, bootstrap?: CreateServerInput): Promise<LocaliumServerInfo> {
  if (activeServer) await activeServer.stop();
  const dataDir = userDataPath('servers', serverId);
  const advertisedHost = pickAdvertisedHost();
  activeServer = new LocaliumServer({
    dataDir,
    port,
    bindHost: '0.0.0.0',
    advertisedHost,
    debug: process.env.LOCALIUM_DEBUG === '1',
    bootstrap: bootstrap
      ? {
          serverId,
          serverName: bootstrap.serverName,
          owner: {
            deviceId: bootstrap.ownerIdentity.deviceId,
            displayName: bootstrap.displayName,
            signPublicKey: bootstrap.ownerIdentity.signPublicKey,
            boxPublicKey: bootstrap.ownerIdentity.boxPublicKey,
            roleIds: ['owner'],
            encryptedRoomKey: bootstrap.encryptedRoomKey
          }
        }
      : undefined
  });
  const info = await activeServer.start();
  trustedFingerprints.add(normalizeFingerprint(info.fingerprint));
  await writeHostConfig(serverId, info.port);
  return info;
}

async function listHostedServers(): Promise<HostedServerSummary[]> {
  const root = userDataPath('servers');
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: HostedServerSummary[] = [];
  for (const serverId of entries) {
    try {
      const [stateRaw, configRaw] = await Promise.all([
        readFile(path.join(root, serverId, 'server-state.json'), 'utf8'),
        readFile(path.join(root, serverId, 'host-config.json'), 'utf8')
      ]);
      const state = JSON.parse(stateRaw) as { serverId: string; createdAt: string; settings: { name: string } };
      const config = JSON.parse(configRaw) as { port: number };
      result.push({ serverId: state.serverId, serverName: state.settings.name, createdAt: state.createdAt, port: config.port });
    } catch {
      // Ignore incomplete server directories instead of exposing filesystem details.
    }
  }
  return result.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function registerIpc(): void {
  ipcMain.handle('vault:load', () => loadVault());
  ipcMain.handle('vault:save', (_event, vault: VaultData) => saveVault(vault));
  ipcMain.handle('security:trustFingerprint', (_event, fingerprint: string) => {
    trustedFingerprints.add(normalizeFingerprint(fingerprint));
  });
  ipcMain.handle('server:create', async (_event, input: CreateServerInput) => {
    const serverId = randomUUID();
    return startServer(serverId, validPort(input.port), input);
  });
  ipcMain.handle('server:listHosted', () => listHostedServers());
  ipcMain.handle('server:startExisting', async (_event, serverId: string, port?: number) => {
    if (!/^[a-f0-9-]{36}$/u.test(serverId)) throw new Error('Invalid server id.');
    let selectedPort = port;
    if (selectedPort === undefined) {
      const raw = await readFile(userDataPath('servers', serverId, 'host-config.json'), 'utf8');
      selectedPort = (JSON.parse(raw) as { port: number }).port;
    }
    return startServer(serverId, validPort(selectedPort));
  });
  ipcMain.handle('server:stop', async () => {
    await activeServer?.stop();
    activeServer = null;
  });
  ipcMain.handle('server:status', () => activeServer?.info ?? null);
  ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const data = await readFile(filePath);
    return { name: path.basename(filePath), dataBase64: data.toString('base64') };
  });
  ipcMain.handle('dialog:openImage', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const data = await readFile(filePath);
    return { name: path.basename(filePath), dataBase64: data.toString('base64') };
  });
  ipcMain.handle('dialog:saveFile', async (_event, input: { suggestedName: string; dataBase64: string }) => {
    const result = await dialog.showSaveDialog({ defaultPath: input.suggestedName });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, Buffer.from(input.dataBase64, 'base64'));
    return true;
  });
  ipcMain.handle('debug:readLogs', async () => {
    if (!activeServer) return '';
    try {
      return await readFile(path.join(activeServer.info.dataDir, 'logs', 'localium.log'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  });
  ipcMain.handle('app:getVersion', () => app.getVersion());
}

app.on('certificate-error', (event, _webContents, _url, _error, certificate, callback) => {
  let fingerprint = '';
  try {
    fingerprint = normalizeFingerprint(new X509Certificate(certificate.data).fingerprint256);
  } catch {
    callback(false);
    return;
  }
  if (trustedFingerprints.has(fingerprint)) {
    event.preventDefault();
    callback(true);
    return;
  }
  callback(false);
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  registerIpc();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void activeServer?.stop();
});
