# Gemini Connect for ChatGPT

ChatGPT から Gemini に執筆、分析、セカンドオピニオン、文章補正を依頼できる、個人用の MCP サーバーです。Gemini の Web 画面へコピー＆ペーストせず、ChatGPT が必要に応じて呼び出し、結果をまとめます。

各自の Cloudflare と Gemini API キーで動作します。API の利用料金は各利用者が負担します。Google ログインは接続者の本人確認用であり、Gemini API キーの取得や設定は別途必要です。

提供する MCP ツールは `ask_gemini` の1つのみです。通常の Gemini への問い合わせと、日本語の文章補正に特化しています。ツールの呼び出し判断と最終的な回答の編集は、接続元の ChatGPT や Codex が行います。

| パラメータ | 用途 |
| --- | --- |
| `prompt` | 新しい依頼の内容、背景情報、対象文章。参照先 URL も本文に含める |
| `job_id` | 受付済みの結果を取得する場合に指定。promptの再送は不要 |
| `writing_rules` | 省略または `false` で通常利用。`true` で自然かつ正確な日本語への文章補正を適用 |
| `research` | Google 検索が必要な場合に `true` を指定。省略または `false` では検索を行わない。本文中の URL は URL Context で参照 |

会話全体の履歴は自動転送しません。指定した入力と必要な文脈のみを Google へ送信します。

## Codex に導入を手伝ってもらう

このリポジトリの URL を Codex に貼り付け、次のように依頼すると、設定ファイルの準備から API キーの登録、デプロイまで案内してもらえます。

```text
https://github.com/hinatamaxxx/gemini-connect-for-chatgpt

Gemini Connect for ChatGPT を、自分の Cloudflare に導入してください。
README と実装を確認し、必要な設定とデプロイを進めてください。
Gemini API キーの取得・安全な登録、Google ログインの設定、
ChatGPT への接続まで手伝ってください。
ログインや同意など、自分で操作する必要がある場面では案内してください。
API キーやシークレットはチャットに貼らずに設定できる方法を使ってください。
```

アカウントの作成、ログイン、権限への同意などは、ご自身で操作します。API キーやパスワードは Codex のチャットへ貼らず、案内されたローカルの入力欄やシークレット登録画面で設定してください。

手動で導入する場合や設定内容を確認したい場合は、以下の手順を進めてください。

## セットアップとデプロイ

本プロジェクトは、コードを各自の環境へデプロイして運用するセルフホスト用実装です。作者が API やサーバーを提供するサービスではありません。インフラ（Cloudflare）および Gemini API の利用枠と費用は、各利用者が管理します。

動作には以下の環境とアカウントが必要です。

- Node.js 22 以上
- Cloudflare アカウント
- Gemini API キー（各自で取得し、利用枠と費用を管理）
- Google Cloud の OAuth 2.0 クライアント（MCP 接続時の本人確認用）

### Cloudflare へのデプロイ

リポジトリを取得し、依存関係のインストール、Cloudflare へのログイン、KV ネームスペースの作成を行います。

```powershell
git clone https://github.com/hinatamaxxx/gemini-connect-for-chatgpt.git
cd gemini-connect-for-chatgpt
npm ci
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
```

配布時の `wrangler.jsonc` には初期値（ダミー値）が設定されています。作成した KV ネームスペースの ID、Worker 名、`PUBLIC_ORIGIN`、および接続を許可する `OWNER_GOOGLE_EMAIL` を自身の環境の値に更新します。

次に、後述の「Google ログインと ChatGPT への接続」を参照して Google OAuth クライアントを作成し、必要なシークレットを登録してデプロイします。Google OAuth はサーバー接続時の本人確認にのみ利用し、Gemini API の呼び出しには登録した `GEMINI_API_KEY` を使用します。

| シークレット | 用途 |
| --- | --- |
| `GEMINI_API_KEY` | Gemini API のアクセスキー |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 接続時の Google アカウント本人確認用 |
| `SESSION_SECRET` | ログイン Cookie および短期 CLI チケットの暗号化・署名用（32文字以上の乱数） |

```powershell
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler deploy
```

ローカル開発時は `.dev.vars.example` を `.dev.vars` にコピーして設定値を入力します。`.dev.vars` は Git の管理対象外です。API キーやシークレットをリポジトリやチャットに貼り付けないでください。

### Google ログインと ChatGPT への接続

Google Cloud コンソールの Google Auth Platform でウェブアプリケーション用 OAuth クライアントを作成します。個人利用の場合は公開ステータスを「テスト」に設定し、テストユーザーとして自身の Google アカウントを登録します。要求スコープは `openid` と `email` のみです。

承認済みのリダイレクト URI には、デプロイした Worker のコールバック URL を登録します。

```text
https://gemini-connect.YOUR-SUBDOMAIN.workers.dev/google/callback
```

ChatGPT の Developer mode で MCP サーバーとして次の URL を登録し、ブラウザで Google ログインを実行して接続します。接続可能な利用者は `wrangler.jsonc` の `OWNER_GOOGLE_EMAIL` に指定したアドレスに限定され、初回認証時に検証された Google アカウントの一意な識別子（sub）が KV に保存されて固定されます。

```text
https://gemini-connect.YOUR-SUBDOMAIN.workers.dev/mcp
```

## Codex でも使う場合

[Antigravity CLI](https://antigravity.google/docs/cli/headless/) を別途インストールし、Google アカウントでログインしてください。MCP との連携設定も Codex に依頼できます（[設定用の補足資料](docs/codex-cli.md)）。ChatGPT だけで使う場合は不要です。

## モデルと文章補正

既定設定は `gemini-flash-latest`、思考レベルは `high`、出力上限は65,536トークンです。この設定では毎回Googleのモデル一覧を確認し、バージョン番号が最も新しい正式版Flashの具体名を選びます。Lite・Pro・プレビュー版は候補に含めません。`latest` の別名はバックグラウンド実行で拒否されたため、具体名に解決して送信します。モデル一覧を取得できなければ開始せず、弱いモデルへ自動変更しません。


モデルを変更する場合は、`wrangler.jsonc` の `GEMINI_MODEL` を書き換えて再デプロイします。変更先のモデルが対応する思考値、出力上限、検索機能については、公式ドキュメントで確認してください。

`writing_rules=true` を指定した場合のみ、[文章ルールのGist](https://gist.github.com/k16shikano/fd287c3133457c4fd8f5601d34aa817d) から `SKILL.md` を参考資料として取得します。これは実行用のスキルとして環境に導入するのではなく、プロンプトの参照資料として読み込むものです。元の文章の意味や事実関係を損なわずに自然な日本語へ推敲し、創作物に対しては比喩や余韻を壊さないよう指示を与えています。

ルールの取得時は ETag ヘッダーを用いて更新の有無を検証し、変更がない場合は本文の再取得と KV への保存処理を省略します。取得処理の制限時間は5秒です。取得に失敗した場合は前回のキャッシュまたは組み込みの代替ルールを適用して処理を継続し、警告を出力します。本文の文字数上限は 60,000 文字であり、途中で切り詰められた不完全な Gist は採用しません。

## 長い処理と利用量

Gemini APIによる生成はバックグラウンドで実行されます。生成が処理中の場合、本MCPは `status: in_progress` と `job_id`（受付番号）を返し、ChatGPTは15秒以上の間隔を空けて同じ `ask_gemini` に `job_id` のみを渡して結果を取得します。1回の接続で生成完了まで待機しないため、生成が60秒を超えてもMCP自身のタイムアウトで処理を打ち切ることはありません。

Gemini APIへの受付および結果取得の通信は、それぞれ15秒で打ち切ります。受付の通信がタイムアウトした場合は、Google側で処理が受け付けられたか確定できないため、自動での再送は行いません。結果取得の通信が失敗した場合は、同じ受付番号で再確認できます。このとき新しい生成は開始されません。HTTP 429が返された場合は、Google側から通知された待機時間や利用枠の分類を返します。日次上限が明示された場合は、利用枠の回復を待つか、Google側のプランや課金設定を確認してください。本MCPからGoogle側の上限を解除することはできません。

受付番号は署名付きで23時間有効です。ChatGPT側が途中で待機を終了した場合は、同じ受付番号で結果を取得するようChatGPTに依頼してください。ツール情報が古い接続では `job_id` が認識されないため、MCPのツール情報を更新して再接続してください。

バックグラウンド実行には `store: true` の指定が必要であり、依頼と応答がGoogle側に保存されます。本MCPは、生成完了時に対象データを自動削除しません。保存期間、削除、データ利用にはGoogleの規定が適用されます。なお、Cloudflare KVには依頼本文や生成結果を保存しません。

応答に含まれる `model`、`thinking_level`、`usage` から、使用モデルと取得可能なトークン利用量を確認できます。`attempts` と `retries` は、そのAPI通信における試行回数を示します。`usage` は全通信を合算した課金明細ではありません。料金と利用枠はGoogle側で確認してください。

## セキュリティと検証

認証方式には OAuth 2.1 および PKCE（S256）を採用し、CIMD（クライアントのメタデータ文書）に対応しています。Google から受け取る ID トークンは、署名、発行元（iss）、宛先（aud）、nonce、有効期限、メールアドレスの確認状態を検証します。接続承認の POST リクエストは同一オリジン判定と CSRF トークンによって保護し、セッション Cookie は暗号化した上で Secure、HttpOnly、SameSite=Lax 属性を付与します。トークンの有効期限は、アクセストークンが1時間、リフレッシュトークンが30日、ログインセッション状態が10分です。Google アカウント自体のアクセストークンやリフレッシュトークンはサーバー側に保存しません。

`wrangler.jsonc` の `AUTH_VERSION` の数値を増やして再デプロイを行うと、過去に発行したすべての MCP アクセストークンと CLI チケットを一括して無効化できます。Google アカウント側でアプリのアクセス権を取り消しても、MCP サーバーが発行した既存トークンは自動失効しないため、アクセス権を即時に遮断したい場合はこの再デプロイを実施します。各種シークレットはログやレスポンスに出力せず、上流のエラーも安全に抽象化した分類のみを返します。CLI チケットの検証に失敗した際のエラーコードは 401 です。

Cloudflare Workers によるレート制限はエッジ拠点単位で適用されるため、全世界からのリクエストに対する厳密な課金上限を保証するものではありません。Gemini API は `background: true`、`store: true` で実行します。Google側の保存・データ利用条件を確認して利用してください。外部ウェブページ、文章ルール、モデルからの応答内容はすべて参考資料として扱い、プロンプトインジェクション（指示の乗っ取り）や未確認の出典を採用しないよう注意してください。

```powershell
npm ci
npm run check
npm test
npm run test:cli
```

モックを用いたテストスイートにより、OAuth フロー、MCP 呼び出し、単一ツールの挙動、CLI チケットの用途・期限・署名検証、最新 Flash モデルの選択ロジック、ルールの更新処理、再試行の上限と対象エラーの判別を検証できます。

公式ドキュメント:

- [Gemini モデル一覧](https://ai.google.dev/gemini-api/docs/models)
- [思考設定ドキュメント](https://ai.google.dev/gemini-api/docs/thinking)
- [バックグラウンド実行](https://ai.google.dev/gemini-api/docs/background-execution)
- [API エラー対策](https://ai.google.dev/gemini-api/docs/troubleshooting)
- [Antigravity CLI](https://antigravity.google/docs/cli/headless/)
- [Cloudflare MCP Handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)

## 設定ファイルの管理と CI

機密情報を含むファイル（`.dev.vars`、`.env`、`wrangler.local.jsonc`）やビルド生成物は、すべて `.gitignore` によりバージョン管理から除外されています。リポジトリを公開・フォークする際は、API キーや OAuth シークレットなどの機密情報を誤ってコミットしないよう確認してください。

Git の管理外で独自の設定ファイルを保持して運用したい場合は、`wrangler.local.jsonc` を作成し、以下のコマンドでデプロイできます。

```powershell
npm run deploy:local
```

GitHub Actions などの CI 環境では、シークレットを必要としない構成で静的型チェック（`npm run check`）、Worker 結合テスト（`npm test`）、CLI 接続先検証（`npm run test:cli`）を実行します。

## ライセンスと文章ルールの出典

本リポジトリのソースコードには MIT License が適用されます。

文章補正で参照する外部 Gist（`SKILL.md`）の本文はリポジトリ内に同梱しておらず、実行時に動的に取得します。参照先 Gist および各依存ライブラリにはそれぞれのライセンスと利用条件が適用され、本リポジトリの MIT License によって再許諾されるものではありません。
