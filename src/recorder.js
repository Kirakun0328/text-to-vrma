// recorder.js — 3Dビューを共有用の GIF / 動画(WebM) に書き出す
//
// GIF: viewer.renderFrameAt() でコマ送りしながらフレームを集め、gif.js でエンコード。
//      ループ再生・どのプラットフォームでも貼れるので共有向き (長い動きは重くなる)。
// WebM: canvas.captureStream() を MediaRecorder でリアルタイム録画。依存なし・高画質・軽量。
import GIF from 'gif.js';
import gifWorkerUrl from 'gif.js/dist/gif.worker.js?url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 共有に適したサイズへ縮小したキャンバスを返す (縦横比は維持)
function scaledCanvas(source, maxWidth) {
  const scale = Math.min(1, maxWidth / source.width);
  const w = Math.round(source.width * scale);
  const h = Math.round(source.height * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(source, 0, 0, w, h);
  return c;
}

/**
 * GIF書き出し。ワンループぶんをコマ送りキャプチャしてエンコードする。
 * @returns {Promise<Blob>}
 */
export async function exportGIF(viewer, {
  duration, fps = 15, maxWidth = 800, quality = 5, onProgress,
} = {}) {
  const canvas = viewer.canvas;
  const total = Math.max(1, Math.round(duration * fps));
  const delay = Math.round(1000 / fps);
  // 1080pでレンダリングしてからGIF幅へ縮小する (スーパーサンプリングで輪郭がきれいに)
  const restore = viewer.beginCapture(1920, 1080);
  const first = scaledCanvas(canvas, maxWidth);

  const gif = new GIF({
    workers: 2,
    quality, // gif.js は小さいほど高画質
    workerScript: gifWorkerUrl,
    width: first.width,
    height: first.height,
  });

  try {
    for (let i = 0; i < total; i++) {
      viewer.renderFrameAt((i / fps) % duration);
      gif.addFrame(scaledCanvas(canvas, maxWidth), { delay, copy: true });
      onProgress?.((i / total) * 0.6); // キャプチャは全体の6割ぶんとして進捗表示
      if (i % 4 === 0) await sleep(0); // UIを固まらせない
    }
  } finally {
    restore();
  }

  return new Promise((resolve, reject) => {
    gif.on('progress', (p) => onProgress?.(0.6 + p * 0.4));
    gif.on('finished', (blob) => resolve(blob));
    gif.on('abort', () => reject(new Error('GIF encoding aborted')));
    gif.render();
  });
}

/**
 * WebM動画書き出し。ワンループぶんをリアルタイム録画する。
 * @returns {Promise<Blob>}
 */
export async function exportWebM(viewer, {
  duration, fps = 30, onProgress,
} = {}) {
  const canvas = viewer.canvas;
  // 1920x1080 の描画バッファで録画 → 出力は 1080p
  const restore = viewer.beginCapture(1920, 1080);
  try {
    const stream = canvas.captureStream(fps);
    const mime = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ].find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';

    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    });

    // 先頭から1ループ再生しながら録画する
    viewer.seek(0);
    viewer.setPaused(false);
    rec.start();
    const startedAt = performance.now();
    const totalMs = duration * 1000;
    while (performance.now() - startedAt < totalMs) {
      onProgress?.(Math.min(1, (performance.now() - startedAt) / totalMs));
      await sleep(80);
    }
    rec.stop();
    return await done;
  } finally {
    restore();
  }
}

// Blob をダウンロードさせる
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
