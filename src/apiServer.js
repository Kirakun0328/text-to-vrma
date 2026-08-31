import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { buildVRMA } from './vrmaBuilder.js';
import { autoExpressions } from './autoExpressions.js';
import { appendNeutralEnding, rescaleSpec, isLoopFriendly } from './specMerge.js';
import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_CLAUDE_MODEL,
  generateMotionWithOpenAI,
  generateMotionWithClaude,
  planArdySegments,
  setApiBase,
} from './llm.js';

const JSON_LIMIT = 1024 * 1024;
const DEFAULT_ARDY_URL = 'http://127.0.0.1:2337';
const ENGINES = ['openai', 'claude', 'ardy'];
// DNSリバインディング対策で許可するHostヘッダー (ポート番号は除いて比較する)
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/**
 * ARDYローカルエンジンでモーションを生成する。
 * アプリ側 (main.js の generateMotionWithArdy) と同じ手順を辿る:
 * GPTで動作分割 (任意) → ARDYで生成 → ループ判定・終端処理・秒数補正・表情付与。
 * ARDY自体はAPIキー不要で、キーがある場合のみ「GPTが頭・ARDYが体」の構成になる。
 */
export async function generateMotionWithArdy(text, {
  ardyUrl = DEFAULT_ARDY_URL,
  apiKey = '',
  model = DEFAULT_OPENAI_MODEL,
  duration = 0,
  waypoints = null,
  fetchImpl = fetch,
} = {}) {
  const base = String(ardyUrl).replace(/\/+$/, '');

  // GPT (頭) が動作分割を担当。キーが無い・失敗した場合はエンジン内蔵の翻訳に任せる
  let plan = null;
  if (apiKey) {
    try {
      plan = await planArdySegments(text, apiKey, model, {});
    } catch (error) {
      console.warn('[Text-To-VRMA API] ARDYの動作分割に失敗、原文のまま生成します:', error.message);
    }
  }

  const body = plan?.segments?.length
    ? { segments: plan.segments.map((s) => ({ text: s.text, duration: s.duration })) }
    : { text };
  if (Array.isArray(waypoints) && waypoints.length) {
    body.waypoints = waypoints.map((w) => ({ x: Number(w?.x) || 0, z: Number(w?.z) || 0 }));
  }
  const forceDur = Number.isFinite(duration) && duration > 0;
  if (forceDur) {
    body.duration = duration;
    if (body.segments?.length) {
      // 複数セグメントはGPTが割り振った比率を保ったまま合計が指定秒数になるよう按分
      const durs = body.segments.map((s) => Number(s.duration) || 0);
      const sum = durs.reduce((a, b) => a + b, 0);
      body.segments = sum > 0
        ? body.segments.map((s, i) => ({ ...s, duration: (durs[i] / sum) * duration }))
        : body.segments.map((s) => ({ ...s, duration: duration / body.segments.length }));
    }
  }

  let res;
  try {
    res = await fetchImpl(`${base}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    const error = new Error(`ARDYエンジン (${base}) に接続できません。エンジンを起動してください`);
    error.status = 503;
    error.code = 'ardy_unavailable';
    throw error;
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const error = new Error(detail.error || `ARDYエンジンがHTTP ${res.status} を返しました`);
    error.status = 502;
    error.code = 'ardy_error';
    throw error;
  }

  const spec = await res.json();
  if (plan) spec.originalText = text;
  // 自動判定のループ既定値 → 非ループは直立姿勢へ戻して終わる → 秒数固定時のみ全体補正
  spec.loop = isLoopFriendly(spec);
  if (!spec.loop) appendNeutralEnding(spec);
  if (forceDur) rescaleSpec(spec, duration);
  // ARDYは表情を作らないので補う (GPTの感情判定があれば優先)
  spec.expressions = autoExpressions(spec.originalText ?? text, spec.duration, plan?.expression);
  return spec;
}

function json(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    ...extraHeaders,
  });
  res.end(payload);
}

function apiError(res, status, message, code, headers = {}) {
  json(res, status, { error: { message, type: 'api_error', code } }, headers);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT) {
      const error = new Error('リクエスト本文が大きすぎます (上限 1 MiB)');
      error.status = 413;
      error.code = 'request_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('有効なJSONを送信してください');
    error.status = 400;
    error.code = 'invalid_json';
    throw error;
  }
}

function safeFilename(name) {
  const cleaned = String(name || 'motion')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return cleaned || 'motion';
}

function openApiDocument() {
  return {
    openapi: '3.1.0',
    info: { title: 'Text-To-VRMA API', version: '1.0.0' },
    paths: {
      '/health': { get: { summary: 'Health check', responses: { 200: { description: 'OK' } } } },
      '/v1/motions': {
        post: {
          summary: 'Generate a motion spec or VRMA from text',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object', required: ['prompt'],
              properties: {
                prompt: { type: 'string', maxLength: 4000 },
                engine: {
                  type: 'string', enum: ENGINES, default: 'openai',
                  description: 'openai: OPENAI_API_KEYが必要 / claude: ANTHROPIC_API_KEYが必要 / ardy: ローカルARDYエンジン (キー不要)',
                },
                model: { type: 'string', description: 'openai・claudeでは生成モデル、ardyでは動作分割に使うGPTモデル' },
                refine: { type: 'boolean', default: true, description: 'openai・claudeで有効な2パス自己修正' },
                format: { type: 'string', enum: ['json', 'vrma'], default: 'json' },
                duration: { type: 'number', exclusiveMinimum: 0, description: 'ardyのみ: 生成する長さ(秒)' },
                waypoints: {
                  type: 'array', description: 'ardyのみ: 移動経路 (床座標)',
                  items: { type: 'object', properties: { x: { type: 'number' }, z: { type: 'number' } } },
                },
              },
            } } },
          },
          responses: { 200: { description: 'Generated motion' }, 400: { description: 'Invalid request' } },
        },
      },
      '/v1/vrma': {
        post: {
          summary: 'Convert an existing motion spec to VRMA',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 200: { description: 'VRMA binary' } },
        },
      },
    },
  };
}

/**
 * Create the public HTTP API. Dependencies can be replaced for tests.
 */
export function createApiServer({
  apiKey = process.env.OPENAI_API_KEY || '',
  claudeApiKey = process.env.ANTHROPIC_API_KEY || '',
  apiToken = process.env.TEXT_TO_MOTION_API_TOKEN || '',
  apiBase = process.env.OPENAI_BASE_URL || '',
  defaultModel = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
  defaultClaudeModel = process.env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_MODEL,
  corsOrigin = process.env.TEXT_TO_MOTION_CORS_ORIGIN || '',
  ardyUrl = process.env.ARDY_URL || DEFAULT_ARDY_URL,
  generateMotion = generateMotionWithOpenAI,
  generateClaude = generateMotionWithClaude,
  generateArdy = generateMotionWithArdy,
  build = buildVRMA,
} = {}) {
  setApiBase(apiBase);

  return createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const corsHeaders = corsOrigin ? {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      Vary: 'Origin',
    } : {};

    if (req.method === 'OPTIONS' && corsOrigin) {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // DNSリバインディング対策: 攻撃者のドメインを一時的に127.0.0.1へ向けると
    // ブラウザは同一オリジンと誤認しCORSを迂回してレスポンスまで読めてしまう。
    // Hostがループバック名でなければ拒否する。トークン運用 (外部公開) では
    // 認証がその役目を負うのでスキップする
    if (!apiToken) {
      const hostname = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
      if (!LOOPBACK_HOSTS.includes(hostname)) {
        apiError(res, 403, 'ループバック以外のHostヘッダーは受け付けません', 'invalid_host', corsHeaders);
        return;
      }
    }

    // ブラウザのCSRF対策: application/json はプリフライトが必須になるため、
    // 悪意あるページからの「単純リクエスト」(text/plain等) を弾ける
    if (req.method === 'POST') {
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        apiError(res, 415, 'Content-Type: application/json を指定してください', 'unsupported_media_type', corsHeaders);
        return;
      }
    }

    if (apiToken && req.headers.authorization !== `Bearer ${apiToken}`) {
      apiError(res, 401, 'Bearerトークンが必要です', 'unauthorized', {
        ...corsHeaders,
        'WWW-Authenticate': 'Bearer',
      });
      return;
    }

    try {
      if (req.method === 'GET' && requestUrl.pathname === '/') {
        json(res, 200, {
          service: 'Text-To-VRMA API',
          status: 'ok',
          endpoints: {
            health: 'GET /health',
            openapi: 'GET /openapi.json',
            generate: 'POST /v1/motions',
            convert: 'POST /v1/vrma',
          },
          engines: ENGINES,
          // generationConfigured は openai 用 (旧クライアント互換)。エンジン別は configured を見る
          generationConfigured: Boolean(apiKey),
          configured: { openai: Boolean(apiKey), claude: Boolean(claudeApiKey) },
          ardyUrl,
        }, corsHeaders);
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/health') {
        json(res, 200, {
          status: 'ok',
          service: 'text-to-vrma',
          engines: ENGINES,
          // openai/claudeはキー必須、ardyはローカルエンジンが起動していれば使える。
          // generationConfigured は openai 用 (旧クライアント互換)
          generationConfigured: Boolean(apiKey),
          configured: { openai: Boolean(apiKey), claude: Boolean(claudeApiKey) },
          ardyUrl,
        }, corsHeaders);
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/openapi.json') {
        json(res, 200, openApiDocument(), corsHeaders);
        return;
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/motions') {
        const body = await readJson(req);
        const engine = body.engine === undefined ? 'openai' : body.engine;
        if (!ENGINES.includes(engine)) {
          apiError(res, 400, `engineは${ENGINES.join('または')}を指定してください`, 'invalid_engine', corsHeaders);
          return;
        }
        // ARDYはローカルエンジンなのでキー不要 (キーがあれば動作分割に使う)
        if (engine === 'openai' && !apiKey) {
          apiError(res, 503, 'サーバーにOPENAI_API_KEYが設定されていません', 'provider_not_configured', corsHeaders);
          return;
        }
        if (engine === 'claude' && !claudeApiKey) {
          apiError(res, 503, 'サーバーにANTHROPIC_API_KEYが設定されていません', 'provider_not_configured', corsHeaders);
          return;
        }
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt || prompt.length > 4000) {
          apiError(res, 400, 'promptは1〜4000文字で指定してください', 'invalid_prompt', corsHeaders);
          return;
        }
        if (body.format !== undefined && !['json', 'vrma'].includes(body.format)) {
          apiError(res, 400, 'formatはjsonまたはvrmaを指定してください', 'invalid_format', corsHeaders);
          return;
        }
        if (body.refine !== undefined && typeof body.refine !== 'boolean') {
          apiError(res, 400, 'refineはbooleanで指定してください', 'invalid_refine', corsHeaders);
          return;
        }
        if (body.duration !== undefined
          && (typeof body.duration !== 'number' || !Number.isFinite(body.duration) || body.duration <= 0)) {
          apiError(res, 400, 'durationは正の数値で指定してください', 'invalid_duration', corsHeaders);
          return;
        }
        if (body.waypoints !== undefined && !Array.isArray(body.waypoints)) {
          apiError(res, 400, 'waypointsは配列で指定してください', 'invalid_waypoints', corsHeaders);
          return;
        }

        // ardyの既定モデルは動作分割 (GPTが頭) に使うのでOpenAI側の既定を流用する
        const model = typeof body.model === 'string' && body.model.trim()
          ? body.model.trim()
          : (engine === 'claude' ? defaultClaudeModel : defaultModel);
        let spec;
        if (engine === 'ardy') {
          spec = await generateArdy(prompt, {
            ardyUrl,
            apiKey,
            model,
            duration: body.duration ?? 0,
            waypoints: body.waypoints ?? null,
          });
        } else if (engine === 'claude') {
          spec = await generateClaude(prompt, claudeApiKey, model, {
            refine: body.refine !== false,
          });
        } else {
          spec = await generateMotion(prompt, apiKey, model, {
            refine: body.refine !== false,
          });
        }

        if (body.format === 'vrma') {
          const payload = Buffer.from(build(spec));
          res.writeHead(200, {
            'Content-Type': 'model/gltf-binary',
            'Content-Length': payload.length,
            'Content-Disposition': `attachment; filename="${safeFilename(spec.name)}.vrma"`,
            ...corsHeaders,
          });
          res.end(payload);
          return;
        }

        json(res, 200, {
          id: `motion_${randomUUID()}`,
          object: 'motion',
          created: Math.floor(Date.now() / 1000),
          engine,
          // ARDYではモデルは動作分割 (GPTが頭) にしか使わない。キーが無ければ未使用
          model: engine === 'ardy' && !apiKey ? null : model,
          spec,
        }, corsHeaders);
        return;
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/vrma') {
        const spec = await readJson(req);
        const payload = Buffer.from(build(spec));
        res.writeHead(200, {
          'Content-Type': 'model/gltf-binary',
          'Content-Length': payload.length,
          'Content-Disposition': `attachment; filename="${safeFilename(spec.name)}.vrma"`,
          ...corsHeaders,
        });
        res.end(payload);
        return;
      }

      apiError(res, 404, 'エンドポイントが見つかりません', 'not_found', corsHeaders);
    } catch (error) {
      console.error('[Text-To-VRMA API]', error);
      apiError(
        res,
        error.status || 500,
        error.status ? error.message : 'モーションの処理に失敗しました',
        error.code || 'internal_error',
        corsHeaders
      );
    }
  });
}

export function startApiServer({
  host = process.env.HOST || '127.0.0.1',
  port = Number(process.env.PORT || 8787),
  ...options
} = {}) {
  const token = options.apiToken ?? process.env.TEXT_TO_MOTION_API_TOKEN ?? '';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !token) {
    throw new Error('外部公開時はTEXT_TO_MOTION_API_TOKENを設定してください');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORTは0〜65535の整数で指定してください');
  }
  const server = createApiServer({ ...options, apiToken: token });
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`Text-To-VRMA API listening on http://${host}:${actualPort}`);
  });
  return server;
}
