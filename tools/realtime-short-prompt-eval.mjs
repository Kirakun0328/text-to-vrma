// Live pipeline evaluation: every case performs fresh Astra + ARDY inference.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { createArdyRealtime } from '../src/ardyRealtime.js';
import { planRealtimeMotion } from '../src/realtimePlan.js';
import { readCodexJsonStream } from '../src/codexWebBridge.js';
import { buildVRMA } from '../src/vrmaBuilder.js';

const cliArguments = process.argv.slice(2).filter(value => value !== '--metrics-only');
const folder = cliArguments[0] || 'realtime-short-prompts';
if (!/^[a-zA-Z0-9-]+$/.test(folder)) throw new Error('Invalid output folder');
const directory = new URL(`../release/${folder}/`, import.meta.url);
const prompts = cliArguments.length > 1 ? cliArguments.slice(1) : ['その場で歩く', '手を振る', '拍手する', 'ジャンプする', 'お辞儀する'];
await mkdir(directory, { recursive: true });
const metricsOnly = process.argv.includes('--metrics-only');
const report = metricsOnly ? JSON.parse(await readFile(new URL('results.json', directory), 'utf8')) : { recordedAt: new Date().toISOString(), model: 'gpt-6-astra', effort: 'low', duration: 6, autoDuration: true, steps: 8,
  jev: 'API key absent; analyze returns null', inference: 'Fresh generation per case; no motion cache or fixed seed',
  limitations: 'Numerical motion activity and VRMA validity do not establish perfect semantic fidelity or visual quality. Playback timings measure Node VRMA construction, not browser loading or rendered frames.',
  timingNotes: 'Case timings are milliseconds since case start. Chunk receipts observe complete NDJSON lines without modifying their bytes; realtime timings have the runtime start as their origin. overlapMs is body-to-full-plan time, not measured latency saved.', cases: [] };
const rounded = value => Math.round(value);

// Observe complete protocol records before the runtime processes or waits on
// them. Pass through the original bytes, with cancellation/backpressure intact.
function observeArdyStream(response, onEvent) {
  if (!response.body) return response;
  const decoder = new TextDecoder();
  let pending = '';
  const observe = line => {
    const type = /^\s*\{\s*"type"\s*:\s*"(meta|chunk|final|error)"/.exec(line)?.[1];
    if (type) onEvent(type);
  };
  const stream = response.body.pipeThrough(new TransformStream({
    transform(bytes, controller) {
      pending += decoder.decode(bytes, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        observe(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
      // The runtime owns invalid/oversized NDJSON validation. Do not retain a
      // second unbounded copy of such a record just for instrumentation.
      if (pending.length > 16 * 1024 * 1024) pending = '';
      controller.enqueue(bytes);
    },
    flush() { observe(pending + decoder.decode()); },
  }));
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function motionMetrics(spec) {
  const range = values => Math.round((Math.max(...values) - Math.min(...values)) * 1000) / 1000;
  const sampleInterval = spec.hips.length > 1 ? spec.hips[1].t - spec.hips[0].t : 0;
  const span = spec.duration + sampleInterval;
  const windowSeconds = Math.min(2, span);
  const lastWindowStart = Math.max(0, span - windowSeconds);
  const lastSecondStart = Math.max(0, span - 1);
  const names = ['hips', 'spine', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg'];
  return { frames: spec.hips.length, duration: spec.duration, windowSeconds, lastWindowStart, lastSecondStart,
    rootRangeM: [0, 1, 2].map(axis => range(spec.hips.map(key => key.p[axis]))),
    bones: Object.fromEntries(names.map(name => {
      const keys = spec.tracks[name];
      const rotations = keys.map(key => new THREE.Quaternion().setFromEuler(new THREE.Euler(...key.r.map(THREE.MathUtils.degToRad), 'XYZ')));
      function excursion(selected) {
        let max = 0;
        for (let i = 0; i < selected.length; i++) for (let j = i + 1; j < selected.length; j++) max = Math.max(max, selected[i].angleTo(selected[j]));
        return rounded(THREE.MathUtils.radToDeg(max));
      }
      return [name, { angularExcursionDeg: excursion(rotations),
        first2sExcursionDeg: excursion(rotations.filter((_, index) => keys[index].t < windowSeconds)),
        final2sExcursionDeg: excursion(rotations.filter((_, index) => keys[index].t >= lastWindowStart - 1e-9)),
        final1sExcursionDeg: excursion(rotations.filter((_, index) => keys[index].t >= lastSecondStart - 1e-9)) }];
    })) };
}

if (metricsOnly) {
  for (const result of report.cases) {
    if (!result.specFile) continue;
    result.metrics = motionMetrics(JSON.parse(await readFile(new URL(result.specFile, directory), 'utf8')));
    console.log(JSON.stringify({ text: result.text, metrics: result.metrics }));
  }
  await writeFile(new URL('results.json', directory), JSON.stringify(report, null, 2));
  process.exit(0);
}

for (const [index, text] of prompts.entries()) {
  const result = { text, timings: {}, progress: [], chunkReceipts: [], playbacks: [], status: 'running' };
  report.cases.push(result);
  const started = performance.now();
  const elapsed = () => rounded(performance.now() - started);
  const controller = new AbortController();
  let runtime, latestFinal, latestBuffer;
  const timeout = setTimeout(() => { result.timedOut = true; controller.abort(new Error('Case exceeded 60 seconds')); runtime?.stop(); }, 60000);
  try {
    runtime = createArdyRealtime({
      analyze: async () => null,
      getState: () => ({ actor_role: 'avatar', input_kind: 'acting_direction_or_dialogue', current_action: '' }),
      fetchImpl: async (url, options) => {
        result.ardyRequest = JSON.parse(options.body);
        result.timings.bodyRequestMs = elapsed();
        const response = await fetch(url, { ...options, signal: AbortSignal.any([controller.signal, options.signal]) });
        result.timings.bodyResponseMs = elapsed();
        return observeArdyStream(response, type => {
          const atMs = elapsed();
          if (type === 'chunk') {
            result.timings.firstChunkReceivedMs ??= atMs;
            result.chunkReceipts.push({ index: result.chunkReceipts.length + 1, atMs });
          } else if (type === 'final') result.timings.bodyFinalReceivedMs = atMs;
        });
      },
      plan: async (prompt, options) => {
        const plan = await planRealtimeMotion(prompt, { ...options, autoDuration: options.autoDuration, model: report.model, effort: report.effort,
          availableExpressions: ['happy', 'sad', 'angry', 'surprised', 'relaxed'],
          onBodyPlan: body => { result.timings.bodyReadyMs ??= elapsed(); options.onBodyPlan(body); },
          request: async (input, streamOptions) => {
            const signal = AbortSignal.any([controller.signal, streamOptions.signal]);
            let response;
            for (let attempt = 0; attempt < 10; attempt++) {
              response = await fetch('http://127.0.0.1:5175/__codex/review-stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
              if (response.status !== 409) break;
              await response.body?.cancel();
              await new Promise(resolve => setTimeout(resolve, 200));
              signal.throwIfAborted();
            }
            return readCodexJsonStream(response, { ...streamOptions, signal,
              onDelta: delta => {
                if (typeof delta === 'string' && delta.length) result.timings.firstDeltaMs ??= elapsed();
                streamOptions.onDelta?.(delta);
              },
            });
          },
        });
        result.timings.fullPlanMs = elapsed();
        result.timings.faceReadyMs = result.timings.fullPlanMs;
        result.plan = plan;
        return plan;
      },
      onStatus: status => { result.lastStatus = status; },
      onProgress: value => result.progress.push(value),
      play: async (spec, active, options) => {
        assert.equal(active(), true);
        const atMs = elapsed();
        const buildStarted = performance.now();
        const buffer = buildVRMA(spec);
        const buildVRMAMs = Number((performance.now() - buildStarted).toFixed(3));
        assert.equal(new DataView(buffer).getUint32(0, true), 0x46546c67, 'Must produce GLB');
        assert.ok(buffer.byteLength > 1000);
        result.timings.firstPlaybackCallMs ??= atMs;
        result.timings.firstPlayMs ??= elapsed();
        if (Number.isFinite(spec.realtime?.firstChunkMs)) result.timings.firstChunkMs = spec.realtime.firstChunkMs;
        if (Number.isFinite(spec.realtime?.firstFrameMs)) result.timings.firstFrameMs = spec.realtime.firstFrameMs;
        result.playbacks.push({ atMs, builtAtMs: elapsed(), buildVRMAMs, duration: spec.duration,
          append: !!options.append, final: !!options.final, loop: spec.loop,
          chunks: spec.realtime?.chunks ?? null, faceReady: spec.realtime?.faceReady ?? null,
          firstChunkMs: spec.realtime?.firstChunkMs ?? null, firstFrameMs: spec.realtime?.firstFrameMs ?? null });
        result.playCalls = (result.playCalls || 0) + 1;
        if (options.final) { result.timings.finalPlayMs = elapsed(); latestFinal = spec; latestBuffer = buffer; }
      },
    });
    await runtime.react(text, 'http://127.0.0.1:2337', { duration: 6, steps: 8, autoDuration: true });
    controller.signal.throwIfAborted();
    assert.ok(latestFinal, 'Expected final playback');
    assert.equal(result.progress.at(-1)?.percent, 100);
    result.status = 'passed';
    result.loop = latestFinal.loop;
    result.realtime = structuredClone(latestFinal.realtime ?? {});
    if (Number.isFinite(latestFinal.realtime?.firstFrameMs)) result.timings.firstFrameMs = latestFinal.realtime.firstFrameMs;
    result.metrics = motionMetrics(latestFinal);
    result.timings.totalMs = elapsed();
    result.timings.overlapMs = result.timings.fullPlanMs - result.timings.bodyReadyMs;
    const prefix = String(index + 1).padStart(2, '0');
    result.specFile = `${prefix}.spec.json`; result.vrmaFile = `${prefix}.vrma`;
    await writeFile(new URL(result.specFile, directory), JSON.stringify(latestFinal));
    await writeFile(new URL(result.vrmaFile, directory), Buffer.from(latestBuffer));
  } catch (error) {
    result.status = result.timedOut ? 'timeout' : 'failed';
    result.error = error.message;
    result.timings.totalMs = elapsed();
  } finally {
    clearTimeout(timeout);
    controller.abort();
    runtime?.stop();
    await writeFile(new URL('results.json', directory), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(result));
  }
}
