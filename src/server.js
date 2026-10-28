import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createStore } from './store.js';

let config, store;
try {
  config = readConfig();
  if (!config.setupRequired) store = await createStore(config);
} catch {
  console.error('起動できません。APP_PASSWORD・APP_ORIGIN・DATABASE_URLの設定とDBへの接続を確認してください。秘密情報はログに表示しません。');
  process.exit(1);
}
const { server } = createApp({ ...config, store });
server.on('error', error => { console.error(`サーバーを起動できません (${error.code || 'UNKNOWN'})。`); process.exitCode = 1; });
server.listen(config.port, config.host, () => console.log(`家計簿: http://${config.host}:${config.port} (${store?.mode || '保存先の設定待ち'})`));
function shutdown() {
  const timer = setTimeout(() => process.exit(1), 25000); timer.unref();
  server.close(async () => { if (store) await store.close(); clearTimeout(timer); });
}
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
