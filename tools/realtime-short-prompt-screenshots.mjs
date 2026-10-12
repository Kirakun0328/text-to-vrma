// Inspect previously generated specimens only. This script never invokes an AI API.
import { writeFile } from 'node:fs/promises';

const tabs = await fetch('http://127.0.0.1:9224/json').then(response => response.json());
const tab = tabs.find(item => item.type === 'page' && item.url.includes(':5175'));
if (!tab) throw new Error('Open the dedicated browser on port 9224 / app port 5175');
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data), request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
};
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const details = process.argv.includes('--details');
const folder = process.argv.find(arg => arg.startsWith('--folder='))?.slice('--folder='.length) || 'realtime-short-prompts';
if (!/^[a-z0-9-]+$/.test(folder)) throw new Error('The specimen folder must be a simple directory name under release');
try {
  const result = await call('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    for (let i = 0; i < 200 && !window.__viewer?.vrm; i++) await new Promise(resolve => setTimeout(resolve, 100));
    const viewer = window.__viewer;
    if (!viewer?.vrm) throw new Error('The sample avatar was not loaded');
    const { buildVRMA } = await import('/src/vrmaBuilder.js');
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const rootFolder = ${JSON.stringify('/release/' + folder + '/')};
    const cases = (await fetch(rootFolder + 'results.json').then(response => response.json())).cases
      ${details ? '.slice(2)' : ''};
    const width = 310, height = 410, title = 36;
    const board = document.createElement('canvas');
    board.width = 6 * width; board.height = cases.length * (height + title);
    const ctx = board.getContext('2d');
    ctx.fillStyle = '#0d1119'; ctx.fillRect(0, 0, board.width, board.height);
    viewer.clearReaction(); viewer.stop(); viewer.setRenderLoop(false);
    viewer.renderer.setPixelRatio(1); viewer.renderer.setSize(width, height, false);
    viewer.camera.aspect = width / height; viewer.camera.updateProjectionMatrix();
    viewer.vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(viewer.vrm.scene);
    const bodyHeight = box.max.y - box.min.y;
    const measurements = [];
    for (const [row, item] of cases.entries()) {
      const spec = await fetch(rootFolder + item.specFile).then(response => response.json());
      await viewer.playVRMA(buildVRMA(spec), false, 0);
      const samples = [], sweep = [];
      for (let frame = 0; frame <= Math.round(spec.duration * 20); frame++) {
        viewer.seek(frame / 20); viewer.vrm.update(0); viewer.vrm.scene.updateMatrixWorld(true);
        const joint = name => viewer.vrm.humanoid.getNormalizedBoneNode(name).getWorldPosition(new THREE.Vector3());
        sweep.push({ time: frame / 20, wristDistance: joint('leftHand').distanceTo(joint('rightHand')),
          feetY: [joint('leftFoot').y, joint('rightFoot').y], hipsY: joint('hips').y });
      }
      const times = ${details} || spec.duration <= 3 ? [0.4, 1.1, spec.duration] : [0.8, 2.8, spec.duration];
      for (const [step, time] of times.entries()) {
        viewer.renderFrameAt(time);
        viewer.vrm.scene.updateMatrixWorld(true);
        const joints = {};
        for (const name of ['hips', 'head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'leftUpperLeg', 'rightUpperLeg']) {
          const bone = viewer.vrm.humanoid.getNormalizedBoneNode(name);
          if (bone) joints[name] = bone.getWorldPosition(new THREE.Vector3()).toArray();
        }
        samples.push({ time, joints });
        const root = viewer.vrm.humanoid.getNormalizedBoneNode('hips').getWorldPosition(new THREE.Vector3());
        for (const [view, side] of ['front', 'side'].entries()) {
          const x = (step * 2 + view) * width, y = row * (height + title);
          const close = ${details} && item.text === '拍手する';
          const airborne = item.text === 'ジャンプする';
          const distance = bodyHeight * (close ? 1.1 : airborne ? 3.5 : 2.35);
          viewer.controls.target.set(root.x, bodyHeight * (close ? 0.72 : airborne ? 0.78 : 0.48), root.z);
          viewer.camera.position.set(root.x + (side === 'side' ? distance : 0), bodyHeight * (close ? 0.73 : airborne ? 0.88 : 0.59),
            root.z + (side === 'front' ? distance : 0));
          viewer.camera.lookAt(viewer.controls.target);
          viewer.renderFrameAt(time);
          ctx.drawImage(viewer.canvas, x, y + title, width, height);
          ctx.fillStyle = '#e7edf9'; ctx.font = '16px sans-serif';
          ctx.fillText(item.text + ' ' + time + 's ' + side, x + 8, y + 25);
        }
      }
      measurements.push({ text: item.text, samples, sweep });
    }
    return { image: board.toDataURL('image/png'), measurements };
  })()` });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  const { image, measurements } = result.result.value;
  const stem = details ? 'detail' : 'contact';
  await writeFile(`release/${folder}/${stem}-sheet.png`, Buffer.from(image.split(',')[1], 'base64'));
  await writeFile(`release/${folder}/${stem}-joints.json`, JSON.stringify(measurements, null, 2));
  console.log(`Saved release/${folder}/${stem}-sheet.png and ${stem}-joints.json`);
} finally {
  await call('Browser.close').catch(() => {});
  socket.close();
}
