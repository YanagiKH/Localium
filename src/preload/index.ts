import { contextBridge, ipcRenderer } from 'electron';
import type { LocaliumDesktopApi } from '../shared/desktop-api.js';

const api: LocaliumDesktopApi = {
  vault: {
    load: () => ipcRenderer.invoke('vault:load'),
    save: (vault) => ipcRenderer.invoke('vault:save', vault)
  },
  security: {
    trustFingerprint: (fingerprint) => ipcRenderer.invoke('security:trustFingerprint', fingerprint)
  },
  server: {
    create: (input) => ipcRenderer.invoke('server:create', input),
    listHosted: () => ipcRenderer.invoke('server:listHosted'),
    startExisting: (serverId, port) => ipcRenderer.invoke('server:startExisting', serverId, port),
    stop: () => ipcRenderer.invoke('server:stop'),
    status: () => ipcRenderer.invoke('server:status')
  },
  dialog: {
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
    openImage: () => ipcRenderer.invoke('dialog:openImage'),
    saveFile: (input) => ipcRenderer.invoke('dialog:saveFile', input)
  },
  debug: {
    readLogs: () => ipcRenderer.invoke('debug:readLogs')
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getPlatform: () => Promise.resolve('desktop')
  }
};

contextBridge.exposeInMainWorld('localium', api);
