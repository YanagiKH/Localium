import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { installAndroidBridge } from './mobile-bridge.js';

installAndroidBridge();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
