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
    this.logPath = path.join(userDataDir, 'ardy-engine.log');
    this.engineDir = engineDir; // tools/ardy-engine (server.py の場所)
    this.child = null;
    this.lastError = null;
  }

  readConfig() {
    let config = {};
    try {
      // PowerShell (インストーラ) が書いたJSONはBOM付きUTF-8のことがあるため取り除く
      config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8').replace(/^\uFEFF/, ''));
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
      logPath: this.logPath,
      lastError: this.lastError,
    };
  }

  /** セットアップスクリプトを目に見えるターミナルで実行する (進捗をユーザーが確認できる) */
  setup() {
    const isMac = process.platform === 'darwin';
    const script = path.join(this.engineDir, isMac ? 'install_mac.sh' : 'install.ps1');
    if (!fs.existsSync(script)) {
      throw new Error(`セットアップスクリプトが見つかりません: ${script}`);
    }
    if (isMac) {
      spawn('open', ['-a', 'Terminal', script], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('cmd.exe', [
        '/c', 'start', 'ARDY Engine Setup',
        'powershell', '-ExecutionPolicy', 'Bypass', '-File', script,
      ], { detached: true, stdio: 'ignore' }).unref();
    }
    return { started: true };
  }

  start() {
    const config = this.readConfig();
    if (!config.pythonExe) {
      const err = new Error('ARDY_NOT_CONFIGURED');
      err.code = 'ARDY_NOT_CONFIGURED';
      throw err;
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
    // PATHを最小構成に洗浄して起動する: ユーザーのPATHに他のPyTorch/CUDA/conda
    // 環境があると、そちらのDLLが混ざって WinError 1114 (DLL初期化失敗) になるため
    let childPath = process.env.PATH;
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      childPath = [
        path.dirname(config.pythonExe),
        path.join(systemRoot, 'System32'),
        systemRoot,
        path.join(systemRoot, 'System32', 'Wbem'),
      ].join(';');
    }
    // stdout/stderrをパイプにすると、Electronが先に終了してARDYだけが残った場合に
    // 次のログ出力がBrokenPipeとなり、生成リクエストの接続まで切れてしまう。
    // 通常ファイルを子プロセスへ直接渡し、親プロセスの寿命から切り離す。
    const logFd = fs.openSync(this.logPath, 'a');
    try {
      fs.writeSync(logFd, `\n--- ARDY start ${new Date().toISOString()} ---\n`);
      this.child = spawn(config.pythonExe, args, {
        cwd: this.engineDir,
        env: { ...process.env, PATH: childPath, TEXT_ENCODER_DEVICE: config.textEncoderDevice },
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      });
    } finally {
      fs.closeSync(logFd);
    }
    this.child.on('error', (error) => {
      this.lastError = `エンジンを起動できませんでした: ${error.message}`;
    });
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
