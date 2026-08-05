import type { DeviceIdentity, VaultData } from './types.js';

export interface CreateServerInput {
  serverName: string;
  displayName: string;
  port?: number;
  ownerIdentity: DeviceIdentity;
  encryptedRoomKey: string;
}

export interface LocaliumServerInfo {
  serverId: string;
  serverName: string;
  endpoint: string;
  fingerprint: string;
  port: number;
  dataDir: string;
}

export interface HostedServerSummary {
  serverId: string;
  serverName: string;
  createdAt: string;
  port: number;
}

export interface LocaliumDesktopApi {
  vault: {
    load(): Promise<VaultData | null>;
    save(vault: VaultData): Promise<void>;
  };
  security: {
    trustFingerprint(fingerprint: string): Promise<void>;
  };
  server: {
    create(input: CreateServerInput): Promise<LocaliumServerInfo>;
    listHosted(): Promise<HostedServerSummary[]>;
    startExisting(serverId: string, port?: number): Promise<LocaliumServerInfo>;
    stop(): Promise<void>;
    status(): Promise<LocaliumServerInfo | null>;
  };
  dialog: {
    openFile(): Promise<{ name: string; dataBase64: string } | null>;
    openImage(): Promise<{ name: string; dataBase64: string } | null>;
    saveFile(input: { suggestedName: string; dataBase64: string }): Promise<boolean>;
  };
  debug: {
    readLogs(): Promise<string>;
  };
  app: {
    getVersion(): Promise<string>;
    getPlatform(): Promise<'desktop' | 'android'>;
  };
}
