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
    this.userDataDir = userDataDir;
    this.configPath = path.join(userDataDir, 'ardy-engine.json');
    this.logPath = path.join(userDataDir, 'ardy-engine.log');
    this.setupLogPath = path.join(userDataDir, 'ardy-setup.log');
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
      // HuggingFaceキャッシュの場所 (Linuxインストーラが大容量ディスク側に置いた場合など)。
      // 実行時も同じキャッシュを見ないとモデルを見つけられず再ダウンロードになる。
      hfHome: process.env.ARDY_HF_HOME || process.env.HF_HOME || config.hfHome || null,
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
    const platform = process.platform;
    const scriptName =
      platform === 'darwin' ? 'install_mac.sh'
      : platform === 'linux' ? 'install_linux.sh'
      : 'install.ps1';
    const script = path.join(this.engineDir, scriptName);
    if (!fs.existsSync(script)) {
      throw new Error(`セットアップスクリプトが見つかりません: ${script}`);
    }
    if (platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', script], { detached: true, stdio: 'ignore' }).unref();
      return { started: true };
    }
    if (platform === 'linux') {
      return this.setupLinux(script);
    }
    spawn('cmd.exe', [
      '/c', 'start', 'ARDY Engine Setup',
      'powershell', '-ExecutionPolicy', 'Bypass', '-File', script,
    ], { detached: true, stdio: 'ignore' }).unref();
    return { started: true };
  }

  /**
   * Linuxはターミナルエミュレータが多様なため、代表的なものを順に試す。
   * どれも無ければ、バックグラウンドで実行しつつ ardy-setup.log へ出力する
   * (進捗はUIのログ表示やファイルで追える)。
   */
  setupLinux(script) {
    // [コマンド, スクリプトを渡す前段の引数] の候補。argvで渡すのでスペースを含むパスも安全。
    const terminals = [
      ['x-terminal-emulator', ['-e', 'bash', script]],
      ['gnome-terminal', ['--', 'bash', script]],
      ['konsole', ['-e', 'bash', script]],
      ['xfce4-terminal', ['-x', 'bash', script]],
      ['mate-terminal', ['--', 'bash', script]],
      ['tilix', ['-e', 'bash', script]],
      ['alacritty', ['-e', 'bash', script]],
      ['kitty', ['bash', script]],
      ['xterm', ['-e', 'bash', script]],
    ];
    for (const [cmd, args] of terminals) {
      if (!this.hasCommand(cmd)) continue;
      try {
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
        return { started: true, terminal: cmd };
      } catch {
        // 次の候補を試す
      }
    }
    // フォールバック: ターミナルが見つからないのでバックグラウンド実行 + ログ出力
    const logFd = fs.openSync(this.setupLogPath, 'a');
    try {
      fs.writeSync(logFd, `\n--- ARDY setup ${new Date().toISOString()} ---\n`);
      spawn('bash', [script], {
        cwd: this.engineDir,
        detached: true,
        stdio: ['ignore', logFd, logFd],
      }).unref();
    } finally {
      fs.closeSync(logFd);
    }
    return { started: true, background: true, logPath: this.setupLogPath };
  }

  /** PATH上に実行可能コマンドがあるか (Linuxのターミナル検出用) */
  hasCommand(cmd) {
    const dirs = (process.env.PATH || '').split(path.delimiter);
    return dirs.some((dir) => {
      if (!dir) return false;
      try {
        fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
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
    // インストーラがモデルキャッシュを既定外 (大容量ディスク等) に置いた場合は、
    // 同じ HF_HOME を渡さないとモデルを見つけられず再ダウンロードになる。
    const childEnv = { ...process.env, PATH: childPath, TEXT_ENCODER_DEVICE: config.textEncoderDevice };
    if (config.hfHome) childEnv.HF_HOME = config.hfHome;
    // stdout/stderrをパイプにすると、Electronが先に終了してARDYだけが残った場合に
    // 次のログ出力がBrokenPipeとなり、生成リクエストの接続まで切れてしまう。
    // 通常ファイルを子プロセスへ直接渡し、親プロセスの寿命から切り離す。
    const logFd = fs.openSync(this.logPath, 'a');
    try {
      fs.writeSync(logFd, `\n--- ARDY start ${new Date().toISOString()} ---\n`);
      this.child = spawn(config.pythonExe, args, {
        cwd: this.engineDir,
        env: childEnv,
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
