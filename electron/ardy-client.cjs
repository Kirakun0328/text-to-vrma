// ardy-client.cjs — ARDYローカルエンジン (tools/ardy-engine/server.py) の起動・監視
//
// エンジンの場所は設定ファイル (userData/ardy-engine.json) で指定する:
//   {
//     "pythonExe": "C:\\...\\venv\\Scripts\\python.exe",
//     "mergedBase": "C:\\...\\llm2vec-base-merged",   // 省略可 (公式gated重みを使う場合)
//     "port": 2337,                                     // 省略可
//     "textEncoderDevice": "cpu"                        // 省略可 (既定: cpu)
//   }
// 環境変数 ARDY_PYTHON / ARDY_MERGED_BASE でも上書きできる。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PORT = 2337;

class ArdyClient {
  constructor({ userDataDir, engineDir }) {
    this.configPath = path.join(userDataDir, 'ardy-engine.json');
    this.engineDir = engineDir; // tools/ardy-engine (server.py の場所)
    this.child = null;
    this.lastError = null;
  }

  readConfig() {
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
    } catch {
      // 設定ファイルなし → 環境変数のみ
    }
    return {
      pythonExe: process.env.ARDY_PYTHON || config.pythonExe || null,
      mergedBase: process.env.ARDY_MERGED_BASE || config.mergedBase || null,
      port: Number(config.port) || DEFAULT_PORT,
      textEncoderDevice: config.textEncoderDevice || 'cpu',
    };
  }

  getStatus() {
    const config = this.readConfig();
    return {
      configPath: this.configPath,
      configured: Boolean(config.pythonExe),
      running: Boolean(this.child && this.child.exitCode === null),
      port: config.port,
      lastError: this.lastError,
    };
  }

  start() {
    const config = this.readConfig();
    if (!config.pythonExe) {
      throw new Error(
        `ARDYエンジンが未設定です。${this.configPath} に pythonExe を設定してください ` +
        '(tools/ardy-engine/install.ps1 でセットアップできます)。'
      );
    }
    if (!fs.existsSync(config.pythonExe)) {
      throw new Error(`Pythonが見つかりません: ${config.pythonExe}`);
    }
    if (this.child && this.child.exitCode === null) {
      return this.getStatus(); // 既に起動中
    }
    const serverScript = path.join(this.engineDir, 'server.py');
    const args = [serverScript, '--port', String(config.port)];
    if (config.mergedBase) args.push('--merged-base', config.mergedBase);
    this.lastError = null;
    this.child = spawn(config.pythonExe, args, {
      cwd: this.engineDir,
      env: { ...process.env, TEXT_ENCODER_DEVICE: config.textEncoderDevice },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.on('data', (d) => process.stdout.write(`[ardy] ${d}`));
    this.child.stderr.on('data', (d) => process.stderr.write(`[ardy] ${d}`));
    this.child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        this.lastError = `エンジンが終了しました (exit ${code})。ログを確認してください。`;
      }
      this.child = null;
    });
    return this.getStatus();
  }

  stop() {
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
      this.child = null;
    }
    return this.getStatus();
  }
}

module.exports = { ArdyClient };
