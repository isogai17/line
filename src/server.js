import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createOpenAIGenerator, sampleGenerator } from './replies.js';

let config;
try {
  config = readConfig(process.env, { sample: process.argv.includes('--demo') });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const { server } = createApp({
  ...config,
  generator: config.demo ? sampleGenerator : createOpenAIGenerator({ apiKey: config.apiKey, model: config.model }),
});

server.on('error', (error) => {
  console.error(`サーバーを起動できませんでした (${error.code || 'UNKNOWN'})。PORTなどの設定を確認してください。`);
  process.exitCode = 1;
});
server.listen(config.port, config.host, () => {
  console.log(config.demo
    ? `ことばの下書きをサンプルモードで起動しました (port ${config.port})。固定例文を表示し、外部APIには接続しません。`
    : `ことばの下書きをAIモードで起動しました (port ${config.port})。`);
});

function shutdown() {
  const timer = setTimeout(() => process.exit(1), 25_000);
  timer.unref();
  server.close(() => clearTimeout(timer));
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
