## Codex で CLI を使う

ChatGPT などは MCP サーバー経由で直接 Gemini API を呼び出しますが、Codex は同じ MCP サーバーからの指示に従い、ローカル環境の Antigravity CLI を実行して処理を行います。ローカルスキルや追加プラグインの導入は不要です。なお、CLI の実行に障害が発生した場合でも、サーバー側の API 呼び出しへ自動的に切り替える処理は行いません。

### Windows での導入手順

公式の Antigravity CLI を導入し、Google アカウントでログインした後に以下のコマンドを実行します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-cli.ps1 -Origin https://gemini-connect.YOUR-SUBDOMAIN.workers.dev
```

スクリプトの配置先は `~/.gemini-connect/ask-antigravity.mjs` です。スクリプトの内容を変更した場合は再インストールを実行します。

### macOS / Linux での導入手順

公式の手順に従って Antigravity CLI を導入し、Google アカウントでログインした後に以下のコマンドを実行します。

```sh
mkdir -p "$HOME/.gemini-connect"
cp scripts/ask-antigravity.mjs "$HOME/.gemini-connect/ask-antigravity.mjs"
printf '%s\n' '{"origin":"https://gemini-connect.YOUR-SUBDOMAIN.workers.dev"}' > "$HOME/.gemini-connect/config.json"
node "$HOME/.gemini-connect/ask-antigravity.mjs" --check
```

`config.json` には MCP の HTTPS オリジン（スキームとホスト名）のみを指定し、パス（`/mcp`）や認証情報は含めません。信頼する接続先はチケットから自動採用せず、この設定ファイルの値と一致するものだけに制限されます。この値は環境変数 `GEMINI_MCP_ORIGIN` でも指定できます。Windows では前述の `install-cli.ps1` がこの設定ファイルも自動で作成します。

### CLI 実行の流れとチケットの仕様

CLI 連携時の実行手順と仕様は以下のとおりです。

1. スクリプトの `--check` オプションで公式の最新リリースとローカル環境を照合し、利用可能な最新 Flash High のモデル名を取得します。バージョンが古い場合は `agy update` を実行した後に再確認します。照合できない場合は処理を中断します。
2. Codex が `ask_gemini` に `prompt` と `cli_models` を渡すと、有効期間5分の `cli_context`（チケット）が返されます。この段階ではサーバー側での API 生成は行いません。
3. Codex は一時的な UTF-8 JSON ファイルに `prompt` と `cli_context` を保存し、スクリプトの引数にファイルパスを渡して実行します。処理終了後に入力ファイルは削除されます。文章ルールの本文は、スクリプトが直接 MCP サーバーから取得します。

発行されるチケットは公開文章ルールの取得専用であり、Gemini API を直接呼び出す権限は含みません。依頼本文や認証キーは含まれず、HTTPS ヘッダーで送信されます。有効期限内であれば再利用できます。CLI は独立した一時ディレクトリかつ plan モードで実行されますが、OS レベルでのサンドボックス隔離ではありません。CLI 自身の保存処理や内部再試行方針に従って動作し、呼び出し元のラッパースクリプト側では再試行を行いません。
