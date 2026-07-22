// Electron メインプロセス — dist/ のビルド成果物を app:// スキームで配信する
// APIキー等の秘密情報は一切埋め込まない (利用者が実行時に入力し、各自のPC内にのみ保存される)
const { app, BrowserWindow, Menu, protocol, net, shell, ipcMain, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CodexClient, friendlyError } = require('./codex-client.cjs');
const { ArdyClient } = require('./ardy-client.cjs');

// file:// では fetch が使えないため、標準スキーム扱いの app:// で配信する
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const DIST_DIR = path.join(__dirname, '..', 'dist');
let codexClient;
let ardyClient;

function broadcastCodexStatus(status) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('codex:account-changed', status);
  }
}

function registerCodexIpc() {
  codexClient = new CodexClient({ cwd: app.getPath('temp') });
  codexClient.on('account-changed', async () => {
    broadcastCodexStatus(await codexClient.getStatus());
  });
  codexClient.on('server-exit', broadcastCodexStatus);

  ipcMain.handle('codex:get-status', () => codexClient.getStatus());
  ipcMain.handle('codex:list-models', () => codexClient.listModels());
  ipcMain.handle('codex:generate-motion', async (_event, request) => {
    try {
      return await codexClient.generateMotion(request);
    } catch (error) {
      throw friendlyError(error);
    }
  });
  ipcMain.handle('codex:login', async () => {
    const result = await codexClient.login();
    if (result.type !== 'chatgpt' || !result.authUrl) {
      throw new Error('Codex からログインURLが返されませんでした。');
    }
    await shell.openExternal(result.authUrl);
    return { loginId: result.loginId };
  });
  ipcMain.handle('codex:logout', async () => {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['キャンセル', 'ログアウト'],
      defaultId: 0,
      cancelId: 0,
      title: 'Codexからログアウト',
      message: 'このPCのCodex CLI全体からログアウトします。続行しますか？',
    });
    if (response !== 1) return codexClient.getStatus();
    return codexClient.logout();
  });
}

function registerArdyIpc() {
  ardyClient = new ArdyClient({
    userDataDir: app.getPath('userData'),
    engineDir: path.join(__dirname, '..', 'tools', 'ardy-engine'),
  });
  ipcMain.handle('ardy:get-status', () => ardyClient.getStatus());
  ipcMain.handle('ardy:start', () => ardyClient.start());
  ipcMain.handle('ardy:stop', () => ardyClient.stop());
  ipcMain.handle('ardy:setup', () => ardyClient.setup());
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    title: 'Text-To-VRMA',
    backgroundColor: '#0a0d16',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  win.maximize(); // 2カラム (パネル + 3Dプレビュー) が見切れないよう最大化で起動

  // 外部リンクは既定ブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // メインフレームを app:// 以外へ遷移させない (万一のXSSでの画面乗っ取り対策)
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://')) {
      event.preventDefault();
      if (url.startsWith('https://')) shell.openExternal(url);
    }
  });

  win.loadURL('app://bundle/');
}

app.whenReady().then(() => {
  registerCodexIpc();
  registerArdyIpc();
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const filePath = path.normalize(path.join(DIST_DIR, rel));
    // dist/ 外へのパストラバーサルを拒否
    if (!filePath.startsWith(DIST_DIR)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });

  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOSはウィンドウを閉じてもアプリが常駐する。ここでエンジンを止めると、
  // Dockから再表示した際に重いモデル初期化を最初からやり直すことになる。
  if (process.platform !== 'darwin') {
    codexClient?.close();
    ardyClient?.stop();
    app.quit();
  }
});

// macOSではウィンドウを閉じてもアプリが常駐するため、Cmd+Qなどの終了時にも
// エンジンを確実に停止し、孤児プロセスを残さない。
app.on('before-quit', () => {
  codexClient?.close();
  ardyClient?.stop();
});
