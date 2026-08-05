<p align="center">
  <img src="docs/images/localium-logo.svg" alt="Localium" width="920">
</p>

<p align="center">
  <a href="https://github.com/YanagiKH/Localium/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/YanagiKH/Localium/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/YanagiKH/Localium/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://github.com/YanagiKH/Localium/actions/workflows/codeql.yml/badge.svg"></a>
  <a href="https://github.com/YanagiKH/Localium/releases"><img alt="Release" src="https://img.shields.io/github/v/release/YanagiKH/Localium?include_prereleases"></a>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-7aa7ff">
</p>

**Localium** は、学校、企業、研究室、組織が自分たちで管理するインフラ上で機密メッセージやファイルを交換するためのセルフホスト型デスクトップチャットです。デスクトップアプリからローカルサーバーを作成することも、招待コードで別の Localium サーバーに参加することもできます。新しい端末は、所有者または権限を持つ管理者の明示的な承認が必要です。

サーバーが保存するのは暗号化されたメッセージとファイルです。本文、ファイル名、スタンプ選択、ファイルデータは端末上で暗号化されてから送信されます。Localium は OpenAI API キー、クラウドアカウント、分析サービス、第三者チャット基盤を必要としません。

> [!IMPORTANT]
> 絶対的な安全を保証できるソフトウェアはありません。Localium は安全性を重視した設計と現代的な暗号技術を採用していますが、実際の安全性は端末、OS 更新、ファイアウォール、信頼できる管理者、バックアップ運用にも依存します。本番利用前に[セキュリティマニュアル](docs/SECURITY_MANUAL.md)を確認してください。

## インターフェース

<p align="center"><img src="docs/images/overview.svg" alt="Localium サーバー選択画面" width="100%"></p>
<p align="center"><img src="docs/images/chat.svg" alt="Localium 暗号化チャット" width="100%"></p>
<p align="center"><img src="docs/images/administration.svg" alt="Localium 管理画面" width="100%"></p>

## 機能

| 領域 | 実装内容 |
| --- | --- |
| サーバー所有 | デスクトップアプリから HTTPS/WSS のプライベートサーバーを作成・実行します。状態と暗号化アセットはホスト端末の Localium データディレクトリに保存されます。 |
| 招待 | 既定の招待コードは 15 分で失効します。永久招待、使用回数制限、即時失効に対応します。 |
| 承認ゲート | 招待コードだけでは参加できません。所有者または `approve_members` 権限を持つメンバーが端末を承認し、その端末向けにルームキーを暗号化する必要があります。 |
| E2EE | XChaCha20-Poly1305 でメッセージとファイルを保護し、X25519 sealed box でルームキーを配送し、Ed25519 署名で端末を認証します。 |
| 通信保護 | サーバーごとにローカル TLS 証明書を生成します。招待コードには SHA-256 指紋が含まれ、指紋が一致する場合のみ証明書を受け入れます。 |
| 機密ファイル | 任意のファイル形式を 25 MiB まで扱えます。端末で暗号化し、不透明な暗号文としてアップロードし、ダウンロード後に端末で復号して保存します。 |
| スタンプ | 6 種類の標準スタンプを同梱しています。権限を持つメンバーは暗号化画像スタンプを追加・削除できます。 |
| 管理 | 承認待ち端末、招待、メンバー、外観、暗号化背景、スタンプ、監査イベント、カスタムロールを管理できます。 |
| カスタム権限 | `manage_server`、`manage_invites`、`approve_members`、`manage_members`、`manage_roles`、`manage_stickers`、`send_messages`、`send_files`、`view_audit` を組み合わせられます。 |
| ローカル鍵保護 | 端末秘密鍵と保存済みルームキーは Electron `safeStorage` で暗号化し、OS の資格情報保護機能を利用します。 |
| デバッグ | 任意の JSON Lines サーバーログ、アプリ内ログ表示、固定検証コマンド、[デバッグマニュアル](docs/DEBUGGING.md)を用意しています。 |

## セキュリティ構成

```text
承認済み端末
  ├─ Ed25519 署名鍵 ───── サーバーチャレンジへ署名
  ├─ X25519 鍵ペア ────── sealed room key を復号
  └─ ルームキー ───────── XChaCha20-Poly1305 でメッセージとファイルを暗号化
               │
               ▼ 証明書ピンニング済み TLS（WSS/HTTPS）
Localium サーバー
  ├─ 署名、ロール、招待、承認、制限、セッションを検証
  ├─ 暗号化メッセージと暗号化アセットを保存
  └─ 保存済み sealed-key からルームキーを導出できない
```

主な安全特性：

- 招待コードに含まれる SHA-256 証明書指紋でサーバーを固定します。
- 接続ごとに異なるチャレンジへ署名して端末を認証します。
- セッショントークンはランダムな 256 ビット値で、メモリ内だけに保持し、12 時間で失効します。
- 招待シークレットは SHA-256 ハッシュのみを保存します。
- 圧縮サイドチャネルを抑えるため WebSocket 圧縮を無効化しています。
- メッセージ、ファイル、1 分あたりの Socket 操作数を制限します。
- Renderer には Node.js 権限がなく、`contextIsolation`、無効化された `nodeIntegration`、厳格な CSP、権限拒否、最小限の preload bridge を使用します。

脅威モデル、制約、導入チェック、脆弱性報告については[セキュリティマニュアル](docs/SECURITY_MANUAL.md)、[アーキテクチャ](docs/ARCHITECTURE.md)、[SECURITY.md](SECURITY.md)を参照してください。

## インストール

### 方法 1：Release インストーラー

[GitHub Releases](https://github.com/YanagiKH/Localium/releases) から対象 OS のファイルを取得します。

- Windows：NSIS インストーラーまたは portable 実行ファイル
- macOS：DMG または ZIP
- Linux：AppImage または `tar.gz`

組織の署名資格情報を Release ワークフローへ設定していない場合、生成物はコード署名されません。配布前に配布元とチェックサムを確認してください。

### 方法 2：ソースから実行

Node.js 22.12 以上、npm 10 以上、対応デスクトップ OS が必要です。

```bash
git clone https://github.com/YanagiKH/Localium.git
cd Localium
npm install
npm run dev
```

### 方法 3：ローカル unpacked アプリを作成

```bash
npm install
npm run package
```

出力は `release/` に作成されます。社内テストや管理対象端末への配布に利用できます。

### 方法 4：プラットフォーム用インストーラーを作成

```bash
npm install
npm run dist
```

インストーラーは対象 OS 上で生成する必要があります。GitHub Release ワークフローは Windows、macOS、Linux のネイティブ runner を使用します。

詳細は[インストールと展開](docs/INSTALLATION.md)を参照してください。

## 最初のサーバー

1. Localium を開き、**Create server** を選択します。
2. サーバー名、表示名、待受ポートを入力します。既定値は `9473` です。
3. **Administration** から 15 分または永久招待を作成します。
4. 信頼できる経路で招待コードを送ります。
5. 参加端末が署名済み承認要求を送信します。
6. 端末名を確認し、承認または拒否します。
7. 承認時、管理者端末が参加端末の X25519 公開鍵へルームキーを暗号化します。
8. 承認済み端末は再接続し、ルームキーをローカル復号してから暗号化コンテンツへアクセスします。

## ネットワーク

Localium は `0.0.0.0` で待ち受け、最初の非 loopback IPv4 アドレスを招待に使用します。クライアントが VPN ホスト名または固定プライベート DNS 名を使用する必要がある場合は、起動前に `LOCALIUM_ADVERTISED_HOST` を設定してください。学校・社内 LAN では次を推奨します。

- 選択した Localium ポートへの TCP 入力だけを許可する。
- ファイアウォールの許可元を信頼済みサブネットに限定する。
- ポートを公開インターネットへ直接公開しない。
- リモート利用には組織管理の VPN または private overlay network を使用する。
- 利用中はホスト端末をオンラインに保つ。
- 管理者承認が必要でも、招待コードは秘密として扱う。

## データ保存先

| OS | 既定のアプリデータルート |
| --- | --- |
| Windows | `%APPDATA%\Localium` |
| macOS | `~/Library/Application Support/Localium` |
| Linux | `~/.config/Localium` |

各サーバーには `servers/<server-id>/server-state.json`、`assets/`、`tls/`、任意の `logs/` があります。クライアント vault は `client-vault.bin` に保存され、OS の secure storage で暗号化されます。Linux で Electron が安全でない `basic_text` バックエンドを使用する場合、Localium は起動を拒否します。GNOME Keyring、KWallet、または対応する secret service が必要です。

## Debug モード

詳細なサーバーログを有効化します。

```bash
LOCALIUM_DEBUG=1 npm run dev
```

PowerShell：

```powershell
$env:LOCALIUM_DEBUG = "1"
npm run dev
```

アプリの **Debug log** から現在のサーバーログを確認できます。ログには招待シークレット、ルームキー、秘密鍵、セッショントークン、平文メッセージ、平文ファイル名を記録しません。詳細は[デバッグマニュアル](docs/DEBUGGING.md)を参照してください。

## 検証

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run package
npm audit --omit=dev --audit-level=high
```

GitHub Actions はリポジトリ lint、TypeScript 検査、暗号・サーバー統合テスト、renderer/main ビルド、本番依存関係監査、クロスプラットフォーム unpacked パッケージ、CodeQL を実行します。

## 現在の制約

- Localium `0.1.0` はサーバーごとに共有ルームキーを 1 つ使用します。メンバー削除後は将来のサーバーアクセスを拒否しますが、そのメンバーが既に保持していた暗号文や鍵を消去することはできません。自動のバージョン付き鍵ローテーションと前方秘匿 sender chain は未実装です。
- 承認済み端末が侵害された場合、その端末が閲覧可能な内容は読み取られる可能性があります。
- サーバーは端末 ID、時刻、暗号文サイズ、メンバー、ロール、ネットワークアドレスなどの運用メタデータを観測できます。
- 組み込みサーバーは小規模から中規模の非公開グループ向けで、大規模公開コミュニティの負荷試験は未実施です。
- 高可用クラスタリングと外部データベース複製は含まれていません。
- Release 署名には管理者が各プラットフォームの証明書を用意する必要があります。

## ドキュメント

- [インストールと展開](docs/INSTALLATION.md)
- [セキュリティマニュアル](docs/SECURITY_MANUAL.md)
- [デバッグマニュアル](docs/DEBUGGING.md)
- [アーキテクチャ](docs/ARCHITECTURE.md)
- [コントリビューション](CONTRIBUTING.md)
- [脆弱性報告](SECURITY.md)
- [英語 README](README.md)
- [中国語 README](README_ZH.md)

## ライセンス

Localium は [MIT License](LICENSE) で公開されています。
