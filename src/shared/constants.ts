export const APP_NAME = 'Localium';
export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 9473;
export const DEFAULT_INVITE_TTL_MS = 15 * 60 * 1000;
export const MAX_MESSAGE_CIPHERTEXT_BYTES = 256 * 1024;
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_HISTORY_MESSAGES = 500;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SOCKET_RATE_LIMIT_PER_MINUTE = 120;

export const PERMISSIONS = [
  'manage_server',
  'manage_invites',
  'approve_members',
  'manage_members',
  'manage_roles',
  'manage_stickers',
  'send_messages',
  'send_files',
  'view_audit'
] as const;

export type Permission = (typeof PERMISSIONS)[number];
