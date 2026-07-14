// viewer.js — three.js シーンで VRM を表示し、生成した VRMA を再生する
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
} from '@pixiv/three-vrm-animation';

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.vrm = null;
    this.mixer = null;
    this.currentAction = null;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1d24);

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    this.camera.position.set(0, 1.2, 3.2);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.9, 0);
    this.controls.enableDamping = true;
    this.controls.update();

    const dir = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9);
    dir.position.set(1.5, 3, 2);
    this.scene.add(dir);
    this.scene.add(new THREE.AmbientLight(0xbfd4ff, Math.PI * 0.35));

    const grid = new THREE.GridHelper(6, 12, 0x3a4152, 0x262b36);
    this.scene.add(grid);

    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMLoaderPlugin(parser));
    this.loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    this.clock = new THREE.Clock();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this.renderer.setAnimationLoop(() => this._tick());
  }

  _resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _tick() {
    const dt = this.clock.getDelta();
    this.controls.update();
    if (this.mixer) this.mixer.update(dt);
    if (this.vrm) this.vrm.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  async loadVRM(url) {
    const gltf = await this.loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('VRMとして解析できないファイルです');
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    // VRM0.x モデルを VRM1 と同じ向き (+Z 正面) に揃える
    VRMUtils.rotateVRM0(vrm);
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
    }
    this.vrm = vrm;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.scene.add(vrm.scene);
    return vrm;
  }

  /**
   * GLB (.vrma) の ArrayBuffer を読み込んで再生する。
   * @param {ArrayBuffer} arrayBuffer
   * @param {boolean} loop
   */
  async playVRMA(arrayBuffer, loop = true) {
    if (!this.vrm) throw new Error('VRM が読み込まれていません');
    const gltf = await new Promise((resolve, reject) =>
      this.loader.parse(arrayBuffer, '', resolve, reject)
    );
    const vrmAnimation = gltf.userData.vrmAnimations?.[0];
    if (!vrmAnimation) throw new Error('VRMA アニメーションの解析に失敗しました');

    const clip = createVRMAnimationClip(vrmAnimation, this.vrm);
    this.mixer.stopAllAction();
    const action = this.mixer.clipAction(clip);
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = true;
    action.play();
    this.currentAction = action;
    return clip.duration;
  }

  stop() {
    this.mixer?.stopAllAction();
    this.vrm?.humanoid?.resetNormalizedPose();
  }
}
