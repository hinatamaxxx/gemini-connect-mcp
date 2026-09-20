import { retryAfterMs, dailyQuotaExceeded } from './retry';
// Return only an allowlisted category and status, never upstream messages or headers.
export function geminiFailure(error: unknown) {
  const attempts = 1;
  const e = error as { status?: unknown; name?: unknown } | null;
  const status = typeof e?.status === 'number' && Number.isInteger(e.status) && e.status >= 400 && e.status <= 599 ? e.status : null;
  const category = dailyQuotaExceeded(e) ? 'daily_quota_exceeded' : status === 429 ? 'quota_or_rate_limit' : status === 503 ? 'upstream_unavailable' : status === 401 || status === 403 ? 'upstream_auth' : status === 400 || status === 404 ? 'request_or_model' : e?.name === 'APIConnectionTimeoutError' || e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : status && status >= 500 ? 'upstream_error' : 'connection_or_internal';
  const messages: Record<string, string> = {
    daily_quota_exceeded: 'Googleが日次の利用枠上限を返しました。短い待機では回復しないため再試行を止めました。AI Studioで利用枠とリセットを確認してください。',
    quota_or_rate_limit: 'Geminiの利用枠または呼び出し頻度の制限です。Google側の利用枠を確認してください。',
    upstream_unavailable: 'Gemini側が一時的に利用できません。少し時間を置いて再度依頼してください。',
    upstream_auth: 'Gemini APIの認証または利用権限に問題があります。管理者がAPIキーとプロジェクトを確認してください。',
    request_or_model: 'Geminiがリクエストまたはモデル設定を受け付けませんでした。管理者による確認が必要です。',
    timeout: 'Geminiの応答が制限時間を超えました。開始時のタイムアウトは受付済みの可能性があるため再送しないでください。結果取得時なら同じ受付番号で確認してください。',
    upstream_error: 'Gemini側でエラーが発生しました。時間を置いて再度依頼してください。',
    connection_or_internal: 'Geminiとの通信またはMCP内部で失敗しました。管理者による確認が必要です。',
  };
  const retryAfter = retryAfterMs(error);
  return { source: 'gemini_api', category, upstream_status: status, retry_after_seconds: retryAfter === null ? null : Math.ceil(retryAfter / 1000), message: messages[category], attempts, retries: attempts - 1, automatic_retry: attempts > 1, warning: 'タイムアウト等の失敗試行も処理済み・課金済みの場合があります。追加の自動再試行は行わないでください。' };
}
