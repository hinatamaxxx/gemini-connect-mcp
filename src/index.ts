import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { authorize } from './auth';
import { askGemini, inputSchema } from './gemini';
import { cliContext, issueCliContext, latestCliFlash } from './cli-context';
import { geminiFailure } from './errors';
import type { Env, OwnerProps } from './env';

const api = {
  async fetch(request, env, ctx) {
    const owner = ctx.props as OwnerProps | undefined;
    if (!owner?.userId || owner.email !== env.OWNER_GOOGLE_EMAIL || owner.version !== env.AUTH_VERSION || !owner.scopes?.includes('gemini:ask') || await env.OAUTH_KV.get('google-owner:' + env.OWNER_GOOGLE_EMAIL) !== owner.userId) return new Response('Forbidden', { status: 403 });
    return createMcpHandler(() => {
      const server = new McpServer({ name: 'gemini-connect', version: '1.6.0' }, { instructions: `
必要なときだけGeminiを呼び、結果と出典を検証・編集・統合する。通常はwriting_rules=false、文章補正はtrue。最新Flash・high思考を使う。秘密や会話全体を送らない。
CodexはローカルAntigravity CLIを使う。ホーム配下 .gemini-connect/ask-antigravity.mjs をNodeで --check 実行し、取得したcli_modelsをask_geminiへ渡す。この場合APIは実行されずcli_contextが返る。
一時UTF-8 JSONファイルへ {"prompt":"依頼と背景","cli_context":返されたcli_context} を保存し、node <ホーム>/.gemini-connect/ask-antigravity.mjs <JSONファイル絶対パス> を実行、終了後入力ファイルを削除する。パスを適切に引用し、本文・チケットをシェル引数へ展開しない。ルールはスクリプトが直接取得する。チケットは5分有効、期限切れならcli_models付きで再準備する。
CLIが古ければ公式agy update後に再確認。未導入・失敗時にAPIへ自動切替しない。ユーザーがAPIを明示した場合のみCodexでもcli_modelsを省略する。
ChatGPTなどCodex以外はcli_modelsを省略してAPIを実行する。ローカルCLIを探さない。APIの一時障害は最大2回再試行される。呼び出し元で重ねて自動再試行しない。usageは返った応答分のみで、失敗試行の課金を含む総額ではない。
` });
      server.registerTool('ask_gemini', {
        description: 'Geminiへ文章生成・分析・第二意見・創作・URL調査を依頼。writing_rules=trueで文章補正。既定は最新Flash・high。Codexはcli_modelsを指定してCLI用チケットを取得、その他は省略してAPI実行。入力はGoogleへ送信され課金され得る。一時障害は最大2回再試行。',
        inputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['gemini:ask'] }] },
      }, async input => {
        if (!(await env.GEMINI_LIMIT.limit({ key: 'owner' })).success) return { isError: true, content: [{ type: 'text', text: '呼び出し回数が多いため、1分ほど待ってください。' }] };
        try {
          if (input.cli_models) {
            const cli_context = await issueCliContext({ model: latestCliFlash(input.cli_models), writing_rules: input.writing_rules, research: input.research }, env);
            const output = { backend: 'antigravity-cli', cli_context };
            return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
          }
          const output = await askGemini(input, env);
          // Do not include upstream errors, request headers, or credentials in tool responses.
          return { isError: !output.text, content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(geminiFailure(error)) }] };
        }
      });
      return server;
    })(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
export default {
  async fetch(request, env, ctx) {
    try {
      if (new URL(request.url).origin !== env.PUBLIC_ORIGIN) return new Response('Invalid host', { status: 400 });
      if (new URL(request.url).pathname === '/cli-context') return cliContext(request, env);
      const provider = new OAuthProvider<Env>({
        apiRoute: '/mcp', apiHandler: api, defaultHandler: { fetch: authorize },
        authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token',
        scopesSupported: ['gemini:ask'], clientIdMetadataDocumentEnabled: true,
        accessTokenTTL: 3600, refreshTokenTTL: 30 * 86400,
        resourceMetadata: { resource: `${env.PUBLIC_ORIGIN}/mcp`, authorization_servers: [env.PUBLIC_ORIGIN], scopes_supported: ['gemini:ask'], resource_name: 'Gemini Connect' },
      });
      return await provider.fetch(request, env, ctx);
    } catch { return new Response('Request failed', { status: 500 }); }
  },
} satisfies ExportedHandler<Env>;
