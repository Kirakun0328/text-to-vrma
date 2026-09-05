import * as THREE from 'three';
import { buildVRMA } from './vrmaBuilder.js';
import { measureMotionChecks } from './motionCompliance.js';
import { measureMotion, measureKinematics } from './motionReview.js';

export async function inspectMotion(viewer, spec, plan, { framing, captureImages = true } = {}) {
  const saved = {
    action: viewer.currentAction, time: viewer.currentAction?.time, paused: viewer.currentAction?.paused,
    camera: viewer.camera.clone(), target: viewer.controls.target.clone(),
    background: viewer.scene.background, fog: viewer.scene.fog, grid: viewer.grid.visible,
    gridPosition: viewer.grid.position.clone(), markers: viewer._waypointGroup?.visible,
  };
  let restoreSize, reviewAction;
  viewer.setRenderLoop(false);
  try {
    await viewer.playVRMA(buildVRMA(spec), false);
    reviewAction = viewer.currentAction;
    restoreSize = viewer.beginCapture(320, 320);
    viewer.scene.background = new THREE.Color('#202838');
    viewer.scene.fog = null;
    viewer.grid.visible = true;
    if (viewer._waypointGroup) viewer._waypointGroup.visible = false;
    const samples = [];
    const bounds = new THREE.Box3();
    const vector = new THREE.Vector3();
    const count = Math.min(1200, Math.ceil(spec.duration * 20));
    for (let i = 0; i <= count; i++) {
      const t = spec.duration * i / count;
      viewer.seek(t);
      viewer.vrm.update(0);
      viewer.vrm.scene.updateMatrixWorld(true);
      const positions = {};
      for (const name of Object.keys(viewer.reviewSkeleton.restPositions)) {
        const node = viewer.vrm.humanoid.getNormalizedBoneNode(name);
        if (!node) continue;
        node.getWorldPosition(vector);
        positions[name] = vector.toArray();
        bounds.expandByPoint(vector);
      }
      samples.push({ t, positions });
    }
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    if (framing) center.fromArray(framing.center);
    const distance = framing?.distance ?? Math.max(size.x, size.y, size.z, 1) / (2 * Math.tan(THREE.MathUtils.degToRad(viewer.camera.fov / 2))) * 1.3;
    const times = [...new Set([0, ...plan.phases.map(p => p.end), spec.duration])].sort((a, b) => a - b);
    // Include regular samples as well as phase boundaries, capped at 12 columns.
    for (let i = 1; i < 6 && times.length < 12; i++) times.push(spec.duration * i / 6);
    const selected = framing?.times ?? [...new Set(times)].sort((a, b) => a - b).slice(0, 12);
    const images = [];
    for (const [label, axis] of (captureImages ? [['Front +Z', 'z'], ['Side +X', 'x']] : [])) {
      const sheet = document.createElement('canvas');
      const columns = 4, rows = Math.ceil(selected.length / columns);
      sheet.width = columns * 320; sheet.height = rows * 348;
      const ctx = sheet.getContext('2d');
      ctx.fillStyle = '#202838'; ctx.fillRect(0, 0, sheet.width, sheet.height);
      viewer.camera.position.copy(center);
      viewer.camera.position[axis] += distance;
      viewer.camera.lookAt(center);
      for (let i = 0; i < selected.length; i++) {
        viewer.renderFrameAt(selected[i]);
        const x = i % columns * 320, y = Math.floor(i / columns) * 348;
        ctx.drawImage(viewer.canvas, x, y, 320, 320);
        ctx.fillStyle = '#ffffff'; ctx.font = '18px sans-serif';
        ctx.fillText(`${label} | ${selected[i].toFixed(2)} s`, x + 8, y + 340);
      }
      images.push(sheet.toDataURL('image/jpeg', 0.82));
    }
    return {
      images,
      framing: { center: center.toArray(), distance, times: selected },
      kinematics: measureKinematics(samples),
      compliance: measureMotionChecks(samples,spec.motionPlan,spec.duration,viewer.reviewSkeleton.restPositions),
      trajectory: samples.filter((_,i)=>i%Math.max(2,Math.ceil(count/150))===0 || i===count).map(s=>({t:s.t,positions:Object.fromEntries(['hips','head','leftHand','rightHand','leftFoot','rightFoot'].filter(n=>s.positions[n]).map(n=>[n,s.positions[n].map(v=>Math.round(v*1000)/1000)]))})),
      metrics: measureMotion(samples, plan, viewer.reviewSkeleton.restPositions),
      keyPositions: selected.map(t => {
        const s = samples.reduce((a, b) => Math.abs(a.t - t) < Math.abs(b.t - t) ? a : b);
        return { t: s.t, positions: Object.fromEntries(['hips', 'head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot'].map(n => [n, s.positions[n]])) };
      }),
    };
  } finally {
    reviewAction?.stop();
    if (reviewAction) viewer.mixer.uncacheClip(reviewAction.getClip());
    if (saved.action) {
      saved.action.play(); saved.action.enabled = true;
      saved.action.paused = false; saved.action.time = saved.time;
      viewer.mixer.update(0); saved.action.paused = saved.paused;
    } else viewer.vrm.humanoid.resetNormalizedPose();
    viewer.currentAction = saved.action;
    viewer.vrm.update(0);
    restoreSize?.();
    viewer.camera.copy(saved.camera);
    viewer.controls.target.copy(saved.target);
    viewer.scene.background = saved.background; viewer.scene.fog = saved.fog;
    viewer.grid.visible = saved.grid; viewer.grid.position.copy(saved.gridPosition);
    if (viewer._waypointGroup) viewer._waypointGroup.visible = saved.markers;
    viewer.clock.getDelta();
    viewer.setRenderLoop(true);
  }
}

// Two images total: front and side, each with A/B at identical camera and times.
export async function comparisonImages(before, after) {
  const output = [];
  for (let i = 0; i < 2; i++) {
    const pictures = await Promise.all([before.images[i],after.images[i]].map(url => new Promise((resolve,reject)=>{
      const img = new Image(); img.onload=()=>resolve(img); img.onerror=()=>reject(new Error('比較画像を読み込めません')); img.src=url;
    })));
    const canvas = document.createElement('canvas');
    canvas.width = pictures[0].width + pictures[1].width;
    canvas.height = Math.max(...pictures.map(p=>p.height)) + 42;
    const ctx=canvas.getContext('2d'); ctx.fillStyle='#202838';ctx.fillRect(0,0,canvas.width,canvas.height);
    let x=0;
    for (const [j,picture] of pictures.entries()) {
      ctx.fillStyle='#fff';ctx.font='24px sans-serif';ctx.fillText(j ? 'B: Corrected' : 'A: Original',x+12,30);
      ctx.drawImage(picture,x,42);x+=picture.width;
    }
    output.push(canvas.toDataURL('image/jpeg',0.85));
  }
  return output;
}
