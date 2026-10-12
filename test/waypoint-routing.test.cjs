const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('authored waypoints use the constraint-capable route with either Codex or ARDY alone', () => {
  const source = fs.readFileSync('src/main.js', 'utf8');
  const start = source.indexOf('function usesRealtimeArdy()');
  const end = source.indexOf('\nfunction ', start + 1);
  for (const planner of ['none', 'codex']) {
    const state = {
      $: id => ({ value: id === 'ardyPlanner' ? planner : '1' }),
      isArdyMode: () => true, isAutoLength: () => true,
      ardyDurationInput: { value: '' }, waypointCheck: { checked: true },
      waypoints: [{ x: 1, z: 2 }, { x: -1, z: 3 }],
    };
    vm.createContext(state);
    vm.runInContext(source.slice(start, end), state);
    assert.equal(state.usesRealtimeArdy(), false, planner);
    state.waypointCheck.checked = false;
    assert.equal(state.usesRealtimeArdy(), true, 'disabled path keeps live generation');
    state.waypointCheck.checked = true;
    state.waypoints.length = 0;
    assert.equal(state.usesRealtimeArdy(), true, 'empty path keeps live generation');
  }
});
