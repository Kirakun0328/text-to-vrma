const test = require('node:test');
const assert = require('node:assert/strict');
test('usage handles multiple buckets and unknown fields without inventing zero', async () => {
  const { usageWindows } = await import('../src/codexUsage.js');
  assert.deepEqual(usageWindows({}), []);
  const rows = usageWindows({ rateLimitsByLimitId: {
    codex: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { windowDurationMins: 10080 } },
    other: { limitName: 'Other', primary: { usedPercent: 0, windowDurationMins: 15 } },
  }});
  assert.deepEqual(rows[0], { label: 'codex · 5時間', used: 25, reset: 1800000000000 });
  assert.equal(rows[1].used, null);
  assert.equal(rows[1].reset, null);
  assert.equal(rows[1].label, 'codex · 7日間');
  assert.equal(rows[2].used, 0);
  assert.equal(usageWindows({ rateLimits: { primary: { usedPercent: 100 } } })[0].used, 100);
});
