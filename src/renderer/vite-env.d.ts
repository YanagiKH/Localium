/// <reference types="vite/client" />

import type { LocaliumDesktopApi } from '../shared/desktop-api.js';

declare global {
  interface Window {
    localium: LocaliumDesktopApi;
  }
}

export {};
