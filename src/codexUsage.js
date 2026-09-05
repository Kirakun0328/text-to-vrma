import { tr } from './i18n.js';
// Missing quota information is unknown, never zero usage.
export function usageWindows(data) {
  const buckets = Object.values(data?.rateLimitsByLimitId ?? {});
  if (!buckets.length && data?.rateLimits) buckets.push(data.rateLimits);
  return buckets.flatMap(bucket => ['primary', 'secondary'].flatMap(key => {
    const window = bucket[key];
    if (!window) return [];
    const used = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
      ? Math.max(0, Math.min(100, window.usedPercent)) : null;
    const mins = window.windowDurationMins;
    const period = typeof mins !== 'number' || mins <= 0 ? (key === 'primary' ? tr('利用枠') : tr('追加の利用枠'))
      : mins % 1440 === 0 ? tr('{n}日間',{n:mins/1440}) : mins % 60 === 0 ? tr('{n}時間',{n:mins/60}) : tr('{n}分間',{n:mins});
    const reset = typeof window.resetsAt === 'number' && window.resetsAt > 0
      && Number.isFinite(new Date(window.resetsAt * 1000).getTime()) ? window.resetsAt * 1000 : null;
    return [{ label: `${bucket.limitName || bucket.limitId || 'Codex'} · ${period}`, used, reset }];
  }));
}

export function renderUsage(container, data) {
  const otherOpen = container.querySelector('details')?.open ?? false;
  container.replaceChildren();
  const buckets = Object.entries(data?.rateLimitsByLimitId ?? {}).filter(([, bucket]) => bucket);
  const main = buckets.find(([id, bucket]) => (bucket.limitId || id) === 'codex')?.[1]
    ?? ((!data?.rateLimits?.limitId || data.rateLimits.limitId === 'codex') ? data?.rateLimits : null);
  const others = buckets.filter(([id, bucket]) => (bucket.limitId || id) !== 'codex').map(([, bucket]) => bucket);
  if (!buckets.length && data?.rateLimits?.limitId && data.rateLimits.limitId !== 'codex') others.push(data.rateLimits);
  const rows = usageWindows({ rateLimits: main ? { ...main, limitName: 'Codex' } : null });
  if (!rows.length) container.textContent = tr('通常のCodex枠は取得できませんでした。');
  appendRows(container, rows);
  if (others.length) {
    const details = document.createElement('details');
    details.open = otherOpen;
    details.style.marginTop = '12px';
    const summary = document.createElement('summary');
    summary.textContent = tr('その他のモデル別利用枠');
    const note = document.createElement('p');
    note.className = 'sub';
    note.textContent = tr('Sparkなど、Codexが返すモデル別の枠です。通常のCodex使用率には合算せず、ここに分けて表示します。');
    details.append(summary, note);
    appendRows(details, usageWindows({ rateLimitsByLimitId: Object.fromEntries(others.map((bucket, i) => [i, bucket])) }));
    container.append(details);
  }
}

function appendRows(container, rows) {
  for (const row of rows) {
    const block = document.createElement('div');
    block.style.marginTop = '8px';
    const label = document.createElement('div');
    label.textContent = `${row.label}: ${row.used === null ? tr('使用率不明') : tr('{used}% 使用（残り {remaining}%）',{used:row.used,remaining:Math.round((100-row.used)*10)/10})}`;
    block.append(label);
    if (row.used !== null) {
      const bar = document.createElement('progress');
      bar.max = 100; bar.value = row.used; bar.style.width = '100%';
      bar.setAttribute('aria-label', tr('{label}の使用率',{label:row.label}));
      block.append(bar);
    }
    const reset = document.createElement('div');
    reset.className = 'sub';
    reset.textContent = row.reset === null ? tr('リセット時刻不明') : tr('リセット：{time}',{time:new Date(row.reset).toLocaleString()});
    block.append(reset); container.append(block);
  }
}
