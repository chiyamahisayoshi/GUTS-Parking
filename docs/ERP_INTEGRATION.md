# ERP 連携ガイド

Guts は ERP を「車両マスタの正」とし、看板上の状態（ステータス・位置・損傷）は Guts が持つ設計です。車両は ERP 側の安定 ID（`external_id`）で結び付けます。

## 認証
`.env` に `ERP_API_KEY`（長いランダム文字列）を設定し、サービスを再起動します。リクエストには `X-ERP-API-Key` ヘッダーを付けます。未設定の場合は 503 を返します。必ず HTTPS 経由で呼び出し、キーは ERP 側のシークレット管理に保存してください。

## エンドポイント
`/api/v1/...` でも同じものを呼べます。連携には `/api/v1` を使ってください。

### `GET /api/v1/health`
稼働確認。`{"status":"ok","version":"x.y.z"}`

### `GET /api/v1/integration/vehicles`
Guts 側の車両一覧（本店）を返します。

```json
{ "vehicles": [ { "id": 1, "external_id": "ERP-0001", "plate": "1234", "vehicle_type": "A-1", "parking_lot_id": 3, "parking_lot_name": "駐車場 1" } ] }
```

### `POST /api/v1/integration/vehicles:sync`
車両基本情報を一括登録・更新します（1 回最大 500 台）。

```json
[ { "external_id": "ERP-0001", "plate": "1234", "vehicle_type": "A-1", "parking_lot_id": 3 } ]
```

- `external_id` が既存なら車番とクラスのみ更新します。看板上のステータス・位置・損傷は上書きしません。
- 新規車両は、`parking_lot_id` 省略時に一番上の駐車場へ入ります。
- エラー: 401（キー不一致）、413（500 台超）、422（必須項目不足・不明な駐車場）。

## 現在の制限と今後
- 連携対象は本店テナントのみです。加盟店ごとの連携には、店舗別キーとテナント指定が必要です（`external_id` はテナント内で一意）。
- 現在は ERP → Guts の一方向の登録です。ジョブの予約情報を ERP から取り込む、廃車・売却の同期（削除）、Webhook による位置変更通知は、実際の ERP の仕様が決まってから追加します。
- 実際の ERP が決まったら、そのフィールドに合わせたアダプタ（変換スクリプト）を別プロセスで作り、上記 API を呼ぶ構成を推奨します（Guts 本体を ERP ごとに変更しません）。
