# 既存Renderを家計簿へ切り替える

対象は GitHub `isogai17/line`、Render `kotoba-draft`、既存URL `https://kotoba-draft.onrender.com` です。コードを更新すると旧返信アプリの代わりに家計簿が起動します。Gitの履歴で旧版は残ります。

## 1. 無料の外部PostgreSQLを用意

1. [Neon](https://console.neon.tech/)へご本人でログイン・登録します。規約の承諾や認証はご本人で行ってください。
2. Freeプランのプロジェクトを作ります。名前の例は `my-money-book`。リージョンは可能ならRenderと近い場所を選びます。
3. プロジェクトの「Connect」で接続文字列をコピーします。例の形は `postgresql://...@.../neondb?sslmode=require` です。接続プールが選べる場合はpooler付き接続先を利用できます。
4. この文字列にはDBの秘密情報が含まれます。チャット・GitHub・家計簿の画面には貼らず、次のRenderの秘密設定だけへ入力します。

Neon以外の通常のPostgreSQLにも対応しますが、TLS証明書を検証できる接続先が必要です。自己署名証明書を回避する設定や `rejectUnauthorized=false` は使用しません。データ保存先の権限はこのアプリ専用にしてください。

参考：[Neon無料枠](https://neon.com/docs/introduction/plans)、[接続文字列](https://neon.com/docs/connect/connect-from-any-app)。無料枠や上限はサービスの最新表示で確認してください。支払いを伴うプランへ勝手に変更しないでください。

## 2. Renderの環境変数を設定

[Render Dashboard](https://dashboard.render.com/)で `kotoba-draft` を選び、Environment → Editを開きます。

| 名前 | 値 |
| --- | --- |
| `HOST` | `0.0.0.0`（既存値を維持） |
| `APP_PASSWORD` | ご自分の12文字以上の利用パスワード。既存値があれば維持可能 |
| `APP_ORIGIN` | `https://kotoba-draft.onrender.com`。設定がない場合は `RENDER_EXTERNAL_URL` を自動利用 |
| `DATABASE_URL` | 手順1のPostgreSQL接続文字列 |

`OPENAI_API_KEY` と `OPENAI_MODEL` は新アプリでは読み取りも使用もしません。AIへの送信・API利用料は発生しません。不要になったキーの管理はご本人で行ってください。

DATABASE_URL未設定の場合は、パスワードでログインした後に保存先設定画面が表示され、保存はできません。DB接続やTLSの設定に問題がある場合は、誤保存を避けるため起動を止めます。接続情報そのものはログへ表示しません。

## 3. 最新コードをデプロイ

1. GitHubの `main` が家計簿のコードになっていることを確認します。READMEのタイトルが「わたしの家計簿」になります。
2. 環境変数を「Save, rebuild, and deploy」で保存します。保存だけの場合は「Manual Deploy → Deploy latest commit」を実行します。
3. `render.yaml` の自動デプロイは旧版と同じ `false` です。GitHubへの保存だけでは公開切り替え完了を意味しません。
4. Liveになったら、既存URLを開きます。利用パスワードを入力し、「クラウド保存・同期済み」が表示されることを確認します。

新しいRenderサービスやディスクの契約は不要です。無料PostgresをRender内で新設する場合は期限に注意してください。Renderの無料DBは作成後30日で期限を迎えるため、ここでは長期保存先に採用していません。

参考：[Renderの無料サービス制限](https://render.com/docs/free)、[永続ディスク](https://render.com/docs/disks)。

## 4. スマホとPCで共有を確認

1. スマホでテスト用の支出100円（メモ「接続確認・削除予定」）を登録します。
2. PCで同じURLへログインし、更新ボタンでその記録が表示されることを確認します。
3. Renderの再デプロイ後も同じ記録が残ることを確認します。
4. テスト記録をゴミ箱へ移し、集計から消えることを確認します。

iPhoneはSafariの共有 → 「ホーム画面に追加」、Androidはブラウザーのメニュー → 「ホーム画面に追加」から使えます。通常のブラウザーでも利用可能です。オフライン時の記録保存はできません。

## 5. 既存データを移す場合

元のExcel・旧Webアプリは変更せず残してください。Excelから帳簿明細のxlsx/CSVを出力し、Web版の「取込・出力」から選び、内容を確認して登録します。クラウドへ取り込むと金融データがRender経由でPostgreSQLへ保存されることを理解してから、ご本人で実行してください。テスト用のデータや秘密設定をGitHubへ保存しないでください。

## 元の返信アプリへ戻す場合

GitHubの過去コミットから戻すコード変更を作成し、Renderで再デプロイします。DBを削除する必要はありません。戻す前に家計簿の全期間JSONとExcelを出力してください。履歴を破壊する強制pushや、DBデータの削除・初期化は行わないでください。
