const { EventEmitter } = require('node:events');
const { execFile, spawn } = require('node:child_process');
const readline = require('node:readline');

const MIN_CODEX_VERSION = [0, 144, 1];
const REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 180_000;

// OpenAI Structured Outputs では object のキーを動的に定義できず、すべての
// properties を required に含める必要がある。VRM のキー一覧を固定して、
// 使わないトラックは空配列として返させる。
const MOTION_BONE_NAMES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
];
const MOTION_EXPRESSION_NAMES = [
  'happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral',
  'aa', 'ih', 'ou', 'ee', 'oh',
  'blink', 'blinkLeft', 'blinkRight',
  'lookUp', 'lookDown', 'lookLeft', 'lookRight',
];

const rotationTrackSchema = () => ({
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['t', 'r'],
    properties: {
      t: { type: 'number', minimum: 0, maximum: 20 },
      r: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: { type: 'number' },
      },
    },
  },
});

const expressionTrackSchema = () => ({
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['t', 'w'],
    properties: {
      t: { type: 'number', minimum: 0, maximum: 20 },
      w: { type: 'number', minimum: 0, maximum: 1 },
    },
  },
});

const MOTION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'duration', 'loop', 'tracks', 'hips', 'expressions'],
  properties: {
    name: { type: 'string' },
    duration: { type: 'number', exclusiveMinimum: 0, maximum: 20 },
    loop: { type: 'boolean' },
    tracks: {
      type: 'object',
      additionalProperties: false,
      required: MOTION_BONE_NAMES,
      properties: Object.fromEntries(
        MOTION_BONE_NAMES.map((name) => [name, rotationTrackSchema()])
      ),
    },
    hips: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['t', 'p'],
        properties: {
          t: { type: 'number', minimum: 0, maximum: 20 },
          p: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: { type: 'number' },
          },
        },
      },
    },
    expressions: {
      type: 'object',
      additionalProperties: false,
      required: MOTION_EXPRESSION_NAMES,
      properties: Object.fromEntries(
        MOTION_EXPRESSION_NAMES.map((name) => [name, expressionTrackSchema()])
      ),
    },
  },
};

function compareVersions(version, minimum = MIN_CODEX_VERSION) {
  const parts = version.split('.').map((value) => Number.parseInt(value, 10));
  for (let index = 0; index < minimum.length; index += 1) {
    const difference = (parts[index] || 0) - minimum[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function friendlyError(error) {
  const message = error?.message || String(error);
  if (error?.code === 'ENOENT' || /not recognized|not found|見つかりません/i.test(message)) {
    return new Error('Codex CLI が見つかりません。Codex CLI をインストールし、PATH を設定してください。');
  }
  if (/usage.?limit|rate.?limit|quota|sessionBudgetExceeded/i.test(message)) {
    return new Error('Codex の利用上限に達しました。時間をおいてから再試行してください。');
  }
  if (/unauthorized|401|authentication required/i.test(message)) {
    return new Error('Codex の認証が必要です。「ChatGPTでログイン」から認証してください。');
  }
  return error instanceof Error ? error : new Error(message);
}

class CodexClient extends EventEmitter {
  constructor({ command = 'codex', cwd, spawnProcess = spawn, exec = execFile } = {}) {
    super();
    this.command = command;
    this.cwd = cwd;
    this.spawnProcess = spawnProcess;
    this.exec = exec;
    this.process = null;
    this.starting = null;
    this.requestId = 0;
    this.pending = new Map();
    this.turns = new Map();
    this.stderr = '';
    this.version = null;
  }

  async getStatus() {
    try {
      await this.ensureServer();
      const result = await this.request('account/read', { refreshToken: false });
      return {
        available: true,
        version: this.version,
        account: result.account,
        requiresOpenaiAuth: result.requiresOpenaiAuth,
      };
    } catch (error) {
      const friendly = friendlyError(error);
      return { available: false, version: this.version, account: null, error: friendly.message };
    }
  }

  async login() {
    await this.ensureServer();
    return this.request('account/login/start', {
      type: 'chatgpt',
      appBrand: 'codex',
      codexStreamlinedLogin: true,
      useHostedLoginSuccessPage: true,
    });
  }

  async logout() {
    await this.ensureServer();
    await this.request('account/logout', {});
    return this.getStatus();
  }

  async listModels() {
    await this.ensureServer();
    const models = [];
    let cursor = null;
    do {
      const result = await this.request('model/list', {
        cursor,
        includeHidden: false,
      });
      models.push(...result.data);
      cursor = result.nextCursor;
    } while (cursor);
    return models.map(({ id, model, displayName, description, isDefault }) => ({
      id,
      model,
      displayName,
      description,
      isDefault,
    }));
  }

  async generateMotion({ model, systemPrompt, prompt, refinePrompt, refine }) {
    if (![model, systemPrompt, prompt].every((value) => typeof value === 'string' && value.trim())) {
      throw new Error('Codex 生成リクエストが不正です。');
    }
    if (model.length > 100 || systemPrompt.length > 100_000 || prompt.length > 10_000) {
      throw new Error('Codex 生成リクエストが長すぎます。');
    }

    await this.ensureServer();
    const account = await this.request('account/read', { refreshToken: true });
    if (account.account?.type !== 'chatgpt') {
      throw new Error('Codex の認証が必要です。「ChatGPTでログイン」から認証してください。');
    }

    const started = await this.request('thread/start', {
      model,
      cwd: this.cwd,
      baseInstructions: systemPrompt,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
    });
    const threadId = started.thread.id;
    let output = await this.runTurn(threadId, prompt, model);

    if (refine && typeof refinePrompt === 'string' && refinePrompt.trim()) {
      output = await this.runTurn(threadId, refinePrompt, model);
    }

    try {
      return JSON.parse(output);
    } catch {
      throw new Error('Codex から有効なモーションJSONが返されませんでした。');
    }
  }

  async runTurn(threadId, text, model) {
    const completed = this.waitForTurn(threadId);
    try {
      await this.request('turn/start', {
        threadId,
        model,
        effort: 'low',
        input: [{ type: 'text', text }],
        outputSchema: MOTION_OUTPUT_SCHEMA,
      });
      return await completed;
    } catch (error) {
      this.cancelTurnWait(threadId, error);
      throw friendlyError(error);
    }
  }

  waitForTurn(threadId) {
    if (this.turns.has(threadId)) throw new Error('Codex のターンが既に実行中です。');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turns.delete(threadId);
        reject(new Error('Codex の応答がタイムアウトしました。'));
      }, TURN_TIMEOUT_MS);
      this.turns.set(threadId, { messages: [], resolve, reject, timer });
    });
  }

  cancelTurnWait(threadId, error) {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    clearTimeout(turn.timer);
    this.turns.delete(threadId);
    turn.reject(error);
  }

  async ensureServer() {
    if (this.process) return;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async start() {
    this.version = await this.detectVersion();
    if (compareVersions(this.version) < 0) {
      throw new Error(`Codex CLI ${this.version} は古いため利用できません。0.144.1 以上へ更新してください。`);
    }

    await new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.command, ['app-server', '--stdio'], {
        cwd: this.cwd,
        env: process.env,
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let settled = false;
      child.once('spawn', () => {
        settled = true;
        this.process = child;
        resolve();
      });
      child.once('error', (error) => {
        if (!settled) reject(friendlyError(error));
      });
    });

    const lines = readline.createInterface({ input: this.process.stdout });
    lines.on('line', (line) => this.handleLine(line));
    this.process.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    this.process.once('exit', (code) => this.handleExit(code));

    await this.request('initialize', {
      clientInfo: { name: 'text-to-vrma', title: 'Text-To-VRMA', version: '1.0.0' },
    });
    this.notify('initialized', {});
  }

  detectVersion() {
    return new Promise((resolve, reject) => {
      this.exec(this.command, ['--version'], {
        env: process.env,
        shell: process.platform === 'win32',
        windowsHide: true,
        timeout: 10_000,
      }, (error, stdout) => {
        if (error) return reject(friendlyError(error));
        const match = String(stdout).match(/(\d+\.\d+\.\d+)/);
        if (!match) return reject(new Error('Codex CLI のバージョンを確認できませんでした。'));
        resolve(match[1]);
      });
    });
  }

  request(method, params = {}) {
    if (!this.process?.stdin?.writable) {
      return Promise.reject(new Error('Codex app-server が起動していません。'));
    }
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex (${method}) がタイムアウトしました。`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  write(message) {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const { method, params } = message;
    if (method === 'item/completed' && params?.item?.type === 'agentMessage') {
      this.turns.get(params.threadId)?.messages.push(params.item.text);
    } else if (method === 'turn/completed') {
      const turn = this.turns.get(params.threadId);
      if (turn) {
        clearTimeout(turn.timer);
        this.turns.delete(params.threadId);
        if (params.turn?.status === 'completed') {
          turn.resolve(turn.messages.at(-1) || '');
        } else {
          turn.reject(new Error(params.turn?.error?.message || 'Codex の生成に失敗しました。'));
        }
      }
    } else if (method === 'account/login/completed' || method === 'account/updated') {
      this.emit('account-changed', { method, ...params });
    }
  }

  handleExit(code) {
    const detail = this.stderr.trim();
    const error = new Error(
      `Codex app-server が終了しました${code === null ? '' : ` (終了コード ${code})`}。` +
      (detail ? `\n${detail}` : '')
    );
    this.process = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const threadId of this.turns.keys()) this.cancelTurnWait(threadId, error);
    this.emit('server-exit', { error: error.message });
  }

  close() {
    this.process?.kill();
    this.process = null;
  }
}

module.exports = {
  CodexClient,
  MIN_CODEX_VERSION,
  MOTION_OUTPUT_SCHEMA,
  compareVersions,
  friendlyError,
};
