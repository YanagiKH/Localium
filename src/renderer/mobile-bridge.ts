import type { LocaliumDesktopApi } from '../shared/desktop-api.js';
import type { VaultData } from '../shared/types.js';

declare global {
  interface Window {
    AndroidNative?: {
      loadVault(): string;
      saveVault(value: string): void;
      trustFingerprint(value: string): void;
      saveFile(name: string, dataBase64: string): boolean;
      getVersion(): string;
    };
  }
}

function chooseFile(accept: string): Promise<{ name: string; dataBase64: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    const cleanup = () => input.remove();
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        cleanup();
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        const result = String(reader.result ?? '');
        cleanup();
        resolve({ name: file.name, dataBase64: result.split(',')[1] ?? '' });
      });
      reader.addEventListener('error', () => {
        cleanup();
        resolve(null);
      });
      reader.readAsDataURL(file);
    }, { once: true });
    document.body.append(input);
    input.click();
  });
}

export function installAndroidBridge(): void {
  const native = window.AndroidNative;
  if (!native || window.localium) return;
  const unsupported = async (): Promise<never> => {
    throw new Error('Android clients can join Localium servers but cannot host a server.');
  };
  const api: LocaliumDesktopApi = {
    vault: {
      load: async () => {
        const value = native.loadVault();
        return value ? JSON.parse(value) as VaultData : null;
      },
      save: async (vault) => native.saveVault(JSON.stringify(vault))
    },
    security: {
      trustFingerprint: async (fingerprint) => native.trustFingerprint(fingerprint)
    },
    server: {
      create: unsupported,
      listHosted: async () => [],
      startExisting: unsupported,
      stop: async () => undefined,
      status: async () => null
    },
    dialog: {
      openFile: () => chooseFile('*/*'),
      openImage: () => chooseFile('image/png,image/jpeg,image/webp,image/gif'),
      saveFile: async (input) => native.saveFile(input.suggestedName, input.dataBase64)
    },
    debug: { readLogs: async () => '' },
    app: {
      getVersion: async () => native.getVersion(),
      getPlatform: async () => 'android'
    }
  };
  window.localium = api;
}
