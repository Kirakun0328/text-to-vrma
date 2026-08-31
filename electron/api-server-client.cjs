// api-server-client.cjs — デスクトップ版からローカルHTTP APIを起動/停止する。
// 既定では起動しない (オプトイン)。設定でONにしたときだけポートを開く。
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const DEFAULT_PORT = 8787;
// アプリからは常にループバックのみ。外部公開したい人は npm run api 側を使う
const BIND_HOST = '127.0.0.1';
const TOKEN_FILE = 'local-api.json';

class LocalApiServer {
  constructor({ userDataDir } = {}) {
    this.userDataDir = userDataDir || '';
    this.server = null;
    this.port = null;
    this.lastError = null;
    // トークン再生成時に同じ設定で起動し直すために保持する
    this.lastConfig = null;
  }

  get tokenPath() {
    return path.join(this.userDataDir, TOKEN_FILE);
  }

  /**
   * アクセストークンを取得する。インストールごとに固定で、無ければ生成して保存する。
   * 起動のたびに変えると外部ツール側を毎回書き換えることになるため固定にしている。
   * 漏れた場合は regenerateToken() で無効化できる。
   */
  getToken() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
      if (typeof saved.token === 'string' && saved.token.length >= 32) return saved.token;
    } catch { /* 未作成・壊れている場合は作り直す */ }
    return this.regenerateToken();
  }

  regenerateToken() {
    const token = randomBytes(24).toString('hex');
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      fs.writeFileSync(this.tokenPath, JSON.stringify({ token }, null, 2), { mode: 0o600 });
    } catch (error) {
      this.lastError = `トークンを保存できませんでした: ${error.message}`;
    }
    return token;
  }

  getStatus() {
    return {
      running: Boolean(this.server),
      port: this.port,
      host: BIND_HOST,
      url: this.server ? `http://${BIND_HOST}:${this.port}` : null,
      token: this.userDataDir ? this.getToken() : null,
      lastError: this.lastError,
    };
  }

  /**
   * APIサーバーを起動する。キーはレンダラー (localStorage) から渡される。
   * @param {object} config
   * @param {number} [config.port]
   * @param {string} [config.openaiApiKey]
   * @param {string} [config.claudeApiKey]
   * @param {string} [config.openaiBaseUrl]
   * @param {string} [config.openaiModel]
   * @param {string} [config.claudeModel]
   */
  async start(config = {}) {
    if (this.server) return this.getStatus();
    this.lastError = null;
    this.lastConfig = config;

    // 0 はOSに空きポートを割り当てさせる指定。未指定 (undefined/null) だけを既定値に倒す
    const port = config.port === undefined || config.port === null
      ? DEFAULT_PORT
      : Number(config.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      this.lastError = 'ポート番号は0〜65535で指定してください';
      return this.getStatus();
    }

    let createApiServer;
    try {
      // src/apiServer.js はESMなので動的importで読む (main.cjsはCJS)
      const modulePath = path.join(__dirname, '..', 'src', 'apiServer.js');
      ({ createApiServer } = await import(pathToFileURL(modulePath).href));
    } catch (error) {
      this.lastError = `APIサーバーの読み込みに失敗しました: ${error.message}`;
      return this.getStatus();
    }

    const server = createApiServer({
      apiKey: config.openaiApiKey || '',
      claudeApiKey: config.claudeApiKey || '',
      apiBase: config.openaiBaseUrl || '',
      apiToken: this.getToken(),
      ...(config.openaiModel ? { defaultModel: config.openaiModel } : {}),
      ...(config.claudeModel ? { defaultClaudeModel: config.claudeModel } : {}),
    });

    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, BIND_HOST);
      });
    } catch (error) {
      this.lastError = error.code === 'EADDRINUSE'
        ? `ポート ${port} は既に使われています。別のポートを指定してください`
        : `APIサーバーを起動できませんでした: ${error.message}`;
      return this.getStatus();
    }

    // 起動後のエラー (回復不能) はステータスに残して停止扱いにする
    server.on('error', (error) => {
      this.lastError = error.message;
      this.server = null;
      this.port = null;
    });

    this.server = server;
    // port:0 のときはOSが割り当てた実際のポートを持つ
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : port;
    return this.getStatus();
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return this.getStatus();
    await new Promise((resolve) => server.close(resolve));
    return this.getStatus();
  }
}

module.exports = { LocalApiServer, DEFAULT_API_PORT: DEFAULT_PORT };
