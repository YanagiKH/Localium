from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def replace_count(text: str, old: str, new: str, count: int, label: str) -> str:
    actual = text.count(old)
    if actual != count:
        raise RuntimeError(f"{label}: expected {count} matches, found {actual}")
    return text.replace(old, new)


app_path = Path("src/renderer/App.tsx")
app = app_path.read_text()

app = replace_once(
    app,
    """      const key = roomKeyRef.current;
      if (!value.removed && value.avatarAssetId && key) void loadAvatarAsset(client, key, value);
""",
    """      const key = roomKeyRef.current;
      if (!value.removed && value.avatarAssetId && key) {
        void loadAvatarAsset(client, key, value);
      } else {
        setAvatarUrls((current) => {
          if (current[value.deviceId]) URL.revokeObjectURL(current[value.deviceId]);
          const next = { ...current };
          delete next[value.deviceId];
          return next;
        });
      }
""",
    "member avatar event cleanup",
)

app = replace_once(
    app,
    """      const key = roomKeyRef.current;
      if (!value.deleted && value.assetId && key) void loadStickerAsset(client, key, value);
""",
    """      const key = roomKeyRef.current;
      if (!value.deleted && value.assetId && key) {
        void loadStickerAsset(client, key, value);
      } else if (value.deleted && value.stickerId) {
        setStickerUrls((current) => {
          if (current[value.stickerId!]) URL.revokeObjectURL(current[value.stickerId!]);
          const next = { ...current };
          delete next[value.stickerId!];
          return next;
        });
      }
""",
    "sticker event cleanup",
)

app = replace_once(
    app,
    """    client.on('server.changed', (payload) => {
      setSnapshot((current) => current ? { ...current, settings: payload as AuthenticatedSnapshot['settings'] } : current);
    });
""",
    """    client.on('server.changed', (payload) => {
      const settings = payload as AuthenticatedSnapshot['settings'];
      setSnapshot((current) => current ? { ...current, settings } : current);
      const key = roomKeyRef.current;
      if (key) void loadBackgroundAsset(client, key, settings.backgroundAssetId);
    });
""",
    "background event refresh",
)

app = replace_once(
    app,
    """  async function loadVisualAssets(client: LocaliumClient, key: string, nextSnapshot: AuthenticatedSnapshot): Promise<void> {
""",
    """  async function loadBackgroundAsset(client: LocaliumClient, key: string, assetId: string | null): Promise<void> {
    if (!assetId) {
      setBackgroundUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
      return;
    }
    try {
      const encrypted = await client.downloadAsset(assetId);
      const decrypted = await decryptBytes(key, encrypted, 'background-asset');
      const bytes = decrypted.buffer.slice(decrypted.byteOffset, decrypted.byteOffset + decrypted.byteLength) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([bytes]));
      setBackgroundUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return url;
      });
    } catch {
      setBackgroundUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    }
  }

  async function loadVisualAssets(client: LocaliumClient, key: string, nextSnapshot: AuthenticatedSnapshot): Promise<void> {
""",
    "background loader insertion",
)

old_background_block = """    if (nextSnapshot.settings.backgroundAssetId) {
      try {
        const encrypted = await client.downloadAsset(nextSnapshot.settings.backgroundAssetId);
        const decrypted = await decryptBytes(key, encrypted, 'background-asset');
        const url = URL.createObjectURL(new Blob([decrypted.buffer.slice(decrypted.byteOffset, decrypted.byteOffset + decrypted.byteLength) as ArrayBuffer], { type: 'image/*' }));
        setBackgroundUrl((current) => {
          if (current) URL.revokeObjectURL(current);
          return url;
        });
      } catch {
        setBackgroundUrl(null);
      }
    } else {
      setBackgroundUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    }
"""
app = replace_once(
    app,
    old_background_block,
    """    await loadBackgroundAsset(client, key, nextSnapshot.settings.backgroundAssetId);
""",
    "background loader replacement",
)

app = replace_once(
    app,
    """      const url = URL.createObjectURL(new Blob([decrypted.buffer.slice(decrypted.byteOffset, decrypted.byteOffset + decrypted.byteLength) as ArrayBuffer], { type: 'image/png' }));
""",
    """      const bytes = decrypted.buffer.slice(decrypted.byteOffset, decrypted.byteOffset + decrypted.byteLength) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([bytes]));
""",
    "sticker blob MIME",
)
app = replace_once(
    app,
    """      const url = URL.createObjectURL(new Blob([decrypted.buffer.slice(decrypted.byteOffset, decrypted.byteOffset + decrypted.byteLength) as ArrayBuffer], { type: 'image/*' }));
""",
    """      const bytes = decrypted.buffer.slice(decrypted.byteOffset, decrypted.byteOffset + decrypted.byteLength) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([bytes]));
""",
    "avatar blob MIME",
)

app = replace_once(
    app,
    """      const bytes = bytesFromBase64(selected.dataBase64);
      if (bytes.length > 5 * 1024 * 1024) throw new Error('Avatar images are limited to 5 MiB.');
""",
    """      const bytes = bytesFromBase64(selected.dataBase64);
      if (bytes.length === 0) throw new Error('The selected avatar is empty.');
      if (bytes.length > 5 * 1024 * 1024) throw new Error('Avatar images are limited to 5 MiB.');
""",
    "avatar size validation",
)

app = replace_once(
    app,
    """  async function reloadMods(): Promise<void> {
""",
    """  async function clearAvatar(): Promise<void> {
    const client = clientRef.current;
    if (!client || !snapshot) return;
    try {
      const updated = await client.request<MemberRecord>({ type: 'member.avatar', assetId: null });
      setSnapshot((current) => current ? {
        ...current,
        self: updated,
        members: current.members.map((member) => member.deviceId === updated.deviceId ? updated : member)
      } : current);
      setAvatarUrls((current) => {
        if (current[updated.deviceId]) URL.revokeObjectURL(current[updated.deviceId]);
        const next = { ...current };
        delete next[updated.deviceId];
        return next;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to remove avatar.');
    }
  }

  async function reloadMods(): Promise<void> {
""",
    "clear avatar function",
)

app = replace_once(
    app,
    """      const selected = await window.localium.dialog.openImage();
      if (!selected) return;
      const encrypted = await encryptBytes(roomKey, bytesFromBase64(selected.dataBase64), 'sticker-asset');
""",
    """      const selected = await window.localium.dialog.openImage();
      if (!selected) return;
      const bytes = bytesFromBase64(selected.dataBase64);
      if (bytes.length === 0) throw new Error('The selected sticker is empty.');
      if (bytes.length > 10 * 1024 * 1024) throw new Error('Sticker images are limited to 10 MiB.');
      const encrypted = await encryptBytes(roomKey, bytes, 'sticker-asset');
""",
    "sticker size validation",
)

app = replace_once(
    app,
    """      const selected = await window.localium.dialog.openImage();
      if (!selected) return;
      const encrypted = await encryptBytes(roomKey, bytesFromBase64(selected.dataBase64), 'background-asset');
""",
    """      const selected = await window.localium.dialog.openImage();
      if (!selected) return;
      const bytes = bytesFromBase64(selected.dataBase64);
      if (bytes.length === 0) throw new Error('The selected background is empty.');
      if (bytes.length > 15 * 1024 * 1024) throw new Error('Background images are limited to 15 MiB.');
      const encrypted = await encryptBytes(roomKey, bytes, 'background-asset');
""",
    "background size validation",
)

app = replace_once(
    app,
    """    setMessages([]);
    setAdminOpen(false);
""",
    """    setMessages([]);
    setBackgroundUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setStickerUrls((current) => {
      for (const url of Object.values(current)) URL.revokeObjectURL(url);
      return {};
    });
    setAvatarUrls((current) => {
      for (const url of Object.values(current)) URL.revokeObjectURL(url);
      return {};
    });
    setAdminOpen(false);
""",
    "disconnect asset cleanup",
)

app = replace_once(
    app,
    """            <div className="profile-card"><MemberAvatar member={snapshot.self} url={avatarUrls[snapshot.self.deviceId]} large /><div><strong>{snapshot.self.displayName}</strong><small>Encrypted device profile</small></div><button onClick={() => void uploadAvatar()}>Change avatar</button></div>
""",
    """            <div className="profile-card"><MemberAvatar member={snapshot.self} url={avatarUrls[snapshot.self.deviceId]} large /><div><strong>{snapshot.self.displayName}</strong><small>Encrypted device profile</small></div><button onClick={() => void uploadAvatar()}>Change avatar</button>{snapshot.self.avatarAssetId && <button className="text-danger" onClick={() => void clearAvatar()}>Remove</button>}</div>
""",
    "avatar remove control",
)

app_path.write_text(app)

mods_path = Path("src/main/mods.ts")
mods = mods_path.read_text()
mods = replace_once(
    mods,
    """const MAX_MOD_FILE_BYTES = 128 * 1024;
const MAX_COMMAND_RESPONSE = 2_000;
""",
    """const MAX_MOD_FILE_BYTES = 128 * 1024;
const MAX_MOD_FILES = 128;
const MAX_TOTAL_COMMANDS = 1_000;
const MAX_COMMAND_RESPONSE = 2_000;
""",
    "mod limits",
)
mods = replace_once(
    mods,
    """      .map((entry) => entry.name)
      .sort();
    const modules: ModModuleConfig[] = [];
""",
    """      .map((entry) => entry.name)
      .sort();
    if (files.length > MAX_MOD_FILES) throw new Error(`Mods directory exceeds ${MAX_MOD_FILES} JSON files.`);
    const modules: ModModuleConfig[] = [];
""",
    "mod file count",
)
mods = replace_once(
    mods,
    """        if (commands.has(command.name)) throw new Error(`Duplicate slash command: /${command.name}.`);
        commands.set(command.name, { module, command });
""",
    """        if (commands.has(command.name)) throw new Error(`Duplicate slash command: /${command.name}.`);
        if (commands.size >= MAX_TOTAL_COMMANDS) throw new Error(`Enabled mods exceed ${MAX_TOTAL_COMMANDS} slash commands.`);
        commands.set(command.name, { module, command });
""",
    "mod command count",
)
mods_path.write_text(mods)

main_activity_path = Path("android/app/src/main/java/dev/localium/android/MainActivity.java")
main_activity = main_activity_path.read_text()
main_activity = replace_once(
    main_activity,
    """    private static boolean isBundledAppUrl(Uri uri) {
        return "file".equals(uri.getScheme()) && uri.toString().startsWith(APP_PREFIX);
    }
""",
    """    private static boolean isBundledAppUrl(Uri uri) {
        return APP_URL.equals(uri.toString());
    }
""",
    "strict bundled URL",
)
main_activity_path.write_text(main_activity)

readme_path = Path("README.md")
readme = readme_path.read_text()
readme = readme.replace("`manage_stickers`, `send_messages`", "`manage_stickers`, `manage_mods`, `send_messages`")
readme = readme.replace("version `0.1.0`", "version `0.2.0`")
readme = readme.replace(
    "GitHub Actions runs repository linting, TypeScript checks, cryptographic and server integration tests, renderer/main builds, production dependency auditing, cross-platform unpacked packaging, and CodeQL analysis.",
    "GitHub Actions runs repository linting, TypeScript checks, cryptographic and server integration tests, renderer/main builds, production dependency auditing, cross-platform desktop packaging, Android APK builds, an API 35 emulator launch inspection, and JavaScript/TypeScript plus Android Java CodeQL analysis."
)
readme_path.write_text(readme)

android_doc_path = Path("docs/ANDROID.md")
android_doc = android_doc_path.read_text()
if "## Distribution signing" not in android_doc:
    android_doc += """

## Distribution signing

CI produces an installable debug APK for emulator and managed-device testing plus an unsigned release APK artifact. Before public or managed production distribution, sign the release APK with an organization-controlled Android signing key and keep that key stable for future updates. Never commit a private signing key or its password to this repository.
"""
android_doc_path.write_text(android_doc)

print("Applied final Localium 0.2 UI, mod, Android, and documentation fixes.")
