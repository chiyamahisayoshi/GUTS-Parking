# モバイルアプリ化（App Store / Google Play）準備

現状の Guts は、スマートフォン対応の Web アプリに PWA の基盤（manifest、Service Worker、アイコン）を追加した状態です。ストア公開は、このアプリを **Capacitor** で包む方式を想定しています（Web のコードをそのまま再利用でき、サーバーは今の VPS のままです）。

## 準備済みのもの
- `static/manifest.webmanifest` / `static/sw.js` / `static/icon.svg` / `static/pwa.js`: ホーム画面に追加でき、オフライン時は画面の骨組みだけ表示します（API はキャッシュしません）。HTTPS でのみ有効です。
- `static/privacy.html`（`/static/privacy.html`）: プライバシーポリシーのひな形。公開前に運営者情報を記入してください。ストア申請に URL が必要です。
- `GET /api/health`: 稼働確認用。
- `/api/v1/...`: 既存の `/api/...` と同じ動作の版付き別名。アプリ版が古くなっても API を壊さないために、モバイルアプリからは `/api/v1` を使います。

## 公開までの手順（概要）
1. **ドメイン + HTTPS を用意する**（必須）。iOS/Android とも平文 HTTP は事実上使えません。`COOKIE_SECURE=1` を維持します。
2. 開発者アカウントを用意: Apple Developer Program（年額）、Google Play Console（初回のみ）。iOS のビルドには Mac と Xcode が必要です。
3. Capacitor を導入し、サーバーのドメインを読み込む設定にする:
   ```bash
   npm i -D @capacitor/cli && npm i @capacitor/core @capacitor/ios @capacitor/android
   npx cap init Guts jp.example.guts
   ```
   `capacitor.config.json` に `"server": { "url": "https://あなたのドメイン" }` を設定します。WebView が同じドメインを開くため、現在の Cookie ログイン（SameSite=Strict）がそのまま動きます。
4. アイコンは 1024×1024 の PNG を用意し、`@capacitor/assets` で各サイズを生成します（`static/icon.svg` を元に作成可）。
5. `npx cap add ios` / `npx cap add android` でネイティブプロジェクトを作成し、Xcode / Android Studio で署名・ビルド・提出します。

## 審査で注意する点
- **Apple の 4.2（最低限の機能）**: 単なる Web サイトのラッパーは却下されることがあります。審査用デモアカウントを提出し、業務アプリとしての機能（ログイン必須の社内ツール）を審査メモで説明します。必要なら、カメラ（損傷写真）やプッシュ通知（ジョブ通知）などのネイティブ機能を追加すると通りやすくなります。
- **アカウント**: 自己登録ではなく管理者が発行する方式です。審査には専用のデモ店舗・デモアカウントを用意してください。アカウント削除はアプリ内ではなく管理者経由になるため、その旨をプライバシーポリシーと審査メモに書きます（アプリ内削除が必要とされた場合は追加開発します）。
- **データ安全性の申告**（Google Play）/ **プライバシー栄養表示**（Apple）: 収集データはユーザー名と業務データのみ、広告・トラッキングなし、通信は HTTPS。
- 加盟店課金をアプリ内で行う場合は、各ストアの課金ルールの対象になります。現状は運営者が手動管理するため、アプリ内に価格や購入導線を置かないでください。

## 今後の改善候補
- ネイティブ向けのトークン認証（Cookie を使わない方式）: `server.url` 方式で問題が出た場合のみ。
- オフラインでの閲覧、プッシュ通知、損傷写真のカメラ撮影。
