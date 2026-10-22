# lambda-kintone-keyword-processor

kintone
のキーワード抽出対象レコードを定期的に検索し、`ks-kintone-keyword-extractor`
を呼び出して処理する AWS Lambda 関数です。

## 1. システム概要

-   **Lambda 関数名（SAM 管理）:** `ks-kintone-keyword-processor-sam`
-   **AWS リージョン:** `ap-northeast-1`（東京）
-   **kintone アプリ ID:** `936`
-   **対象条件:** `KeywordExtractionStatus` が `依頼中` のレコード
-   **1回の実行上限:** 現在の実装では最大 3 レコード（コードの `limit 3`
    による）
-   **呼び出し先:** `ks-kintone-keyword-extractor`

> AWS コンソールで先に作成された `ks-kintone-keyword-processor`
> とは別に、SAM 管理の関数として `ks-kintone-keyword-processor-sam`
> を使用しています。デプロイ先を間違えないようにしてください。

## 2. 処理フロー

1.  kintone アプリ `936` から、ステータスが `依頼中`
    のレコードをレコード番号順に最大 3 件取得する。
2.  対象レコードごとに `ks-kintone-keyword-extractor`
    を同期呼び出しする。
3.  extractor の応答を確認し、成功・失敗を記録する。
4.  失敗したレコードについて、`KeywordExtractionStatus` を `エラー`
    に更新し、日時とエラー内容を保存する。
5.  実行結果を Lambda の戻り値および CloudWatch Logs に出力する。

### 注意：重複処理の防止

現在の基本フローでは、検索したレコードを処理開始時に必ず `処理中`
へ変更する仕組みがない場合、同時実行や再実行により同じレコードを重複処理する可能性があります。EventBridge
による定期実行を有効化する前に、状態遷移・同時実行制御を実装／確認してください。

## 3. kintone のフィールド

  ------------------------------------------------------------------------
  フィールドコード                    用途
  ----------------------------------- ------------------------------------
  `KeywordExtractionStatus`           抽出状態。処理対象は `依頼中`

  `KeywordExtractionDate`             処理日時

  `KeywordExtractionError`            エラー内容

  `SearchKeyword`                     extractor
                                      がキーワードを保存するフィールド

  `KeywordExtractionPrompt`           extractor
                                      が使用するレコードごとのプロンプト

  `File`                              extractor が読み取る添付ファイル
  ------------------------------------------------------------------------

`KeywordExtractionStatus`
はドロップダウンフィールドです。実装上の検索クエリは次の形式で、`in`
演算子を使用しています。

``` text
KeywordExtractionStatus in ("依頼中") order by $id asc limit 3
```

実際のフィールドコード・選択肢は kintone
アプリの設定と一致させてください。

## 4. 環境変数

  ----------------------------------------------------------------------------------------------------
  変数                                                必須 説明
  --------------------------- ---------------------------- -------------------------------------------
  `KINTONE_BASE_URL`                                  はい kintone のベース
                                                           URL。例：`https://si-team-dev.cybozu.com`

  `KINTONE_API_TOKEN`                                 はい アプリ 936
                                                           のレコード検索・更新に必要な権限を持つ API
                                                           トークン

  `EXTRACTOR_FUNCTION_NAME`                           はい 呼び出し先 extractor Lambda 名。通常は
                                                           `ks-kintone-keyword-extractor`

  `AWS_REGION`                                      いいえ AWS リージョン。通常は `ap-northeast-1`
  ----------------------------------------------------------------------------------------------------

API トークンは README
やソースコードに記載しないでください。環境変数として安全に管理し、トークンをログに出力しないでください。

## 5. 依存ライブラリ

-   `axios` --- kintone REST API との通信
-   `@aws-sdk/client-lambda` --- extractor Lambda の呼び出し
-   `esbuild` --- バンドルとビルド

実際の依存関係のバージョンは `package.json` と lockfile
を正としてください。

## 6. ビルド・デプロイ

会社の開発方針に従い、`npm` ではなく `pnpm` を使用します。

``` powershell
pnpm build
sam build
sam deploy
```

現在のビルド設定では、`index.mjs` を CommonJS 形式に変換して
`dist/index.js`
を生成する構成です。ビルド設定を変更した場合は、`template.yaml` の
`CodeUri` と
`Handler`、生成ファイル名が一致していることを確認してください。

## 7. 手動テスト

テスト前に、kintone アプリ 936
に添付ファイル付きのテストレコードを用意し、`KeywordExtractionStatus` を
`依頼中` に設定します。対象レコードが複数ある場合、最大 3
件が処理されます。

PowerShell で実行：

``` powershell
aws lambda invoke `
  --function-name ks-kintone-keyword-processor-sam `
  --region ap-northeast-1 `
  --cli-binary-format raw-in-base64-out `
  --payload "{}" `
  response.json
```

結果を確認：

``` powershell
Get-Content .\response.json
```

呼び出しの `StatusCode` が `200`
でも、各レコードの処理がすべて成功したとは限りません。レスポンスの
`body` 内の `results` と、kintone レコード、CloudWatch Logs
を併せて確認してください。

## 8. IAM 権限

実行ロールには、少なくとも次の権限が必要です。

-   CloudWatch Logs へのログ出力
-   `ks-kintone-keyword-extractor` に対する `lambda:InvokeFunction`
-   実装が kintone にアクセスするためのネットワーク接続（通常は HTTPS
    経由）

`lambda:InvokeFunction` のリソースは、対象の extractor 関数 ARN
に絞ることを推奨します。

## 9. EventBridge による定期実行

定期実行は EventBridge からこの processor Lambda
を呼び出す構成を想定しています。スケジュールを有効化する前に、次を確認してください。

1.  手動実行で対象レコードを正常処理できること。
2.  重複処理を防ぐ状態遷移または同時実行制御があること。
3.  エラー時に `KeywordExtractionError` に原因が記録されること。
4.  EventBridge のターゲットが `ks-kintone-keyword-processor-sam`
    であること。
5.  1回に処理する件数と実行間隔が、ファイル量・Bedrock 応答時間・Lambda
    タイムアウトに適していること。

EventBridge
のルール／スケジュールは、現時点で作成済みとは限りません。AWS
コンソールまたは SAM テンプレートで実際の設定状態を確認してください。

## 10. トラブルシューティング

-   **HTTP 400 / `GAIA_IQ03`:** kintone
    クエリの演算子やフィールドタイプを確認する。現在のステータス検索では
    `in ("依頼中")` を使用する。
-   **`Dynamic require of "util" is not supported`:** ESM
    のままバンドルした際に発生した問題。現在のビルドでは CommonJS
    (`format: "cjs"`) で `dist/index.js` を生成する。
-   **processor から extractor を呼び出せない:**
    `EXTRACTOR_FUNCTION_NAME`、リージョン、IAM の
    `lambda:InvokeFunction` 権限を確認する。
-   **kintone API が HTTP 400 を返す:** CloudWatch Logs の
    `responseData` にある `code` と `message` を確認する。
-   **結果が `エラー` になる:** kintone の `KeywordExtractionError` と
    extractor 側の CloudWatch Logs を確認する。

## 11. 関連プロジェクト

`kintone-keyword-extractor` は、添付ファイルのテキスト抽出、Bedrock
によるキーワード生成、kintone への結果保存を担当します。
