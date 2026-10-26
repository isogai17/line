const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

export function readConfig(env = process.env, { sample = false } = {}) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORTは1〜65535の整数を指定してください。');
  const host = env.HOST?.trim() || '127.0.0.1';
  const password = env.APP_PASSWORD || '';
  const localOnly = loopbackHosts.has(host);
  if (password && [...password].length < 12) throw new Error('APP_PASSWORDは12文字以上にしてください。');

  let origin = '';
  // Renderでは公開URLが自動注入されるため、URL確定後の手動再設定は不要。
  const configuredOrigin = env.APP_ORIGIN?.trim() || env.RENDER_EXTERNAL_URL?.trim();
  if (configuredOrigin) {
    let url;
    try { url = new URL(configuredOrigin); } catch { throw new Error('APP_ORIGINに公開URLのオリジンを指定してください。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('APP_ORIGINはパスを含まないhttpまたはhttpsのURLにしてください。');
    }
    origin = url.origin;
  }
  if (!localOnly && (!password || !origin.startsWith('https://'))) {
    throw new Error('外部に公開する場合はAPP_PASSWORD（12文字以上）とAPP_ORIGIN（httpsの公開URL）を設定してください。');
  }
  const apiKey = env.OPENAI_API_KEY?.trim() || '';
  return { port, host, localOnly, password, origin, apiKey, model: env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini', demo: sample || !apiKey };
}
