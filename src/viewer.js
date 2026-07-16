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

    // ルート移動 (歩行・経由地) で歩き回れるよう広めに敷く
    const grid = new THREE.GridHelper(40, 80, 0x3a4152, 0x262b36);
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
    if (this.mixer) this.mixer.update(dt);
    if (this.vrm) this.vrm.update(dt);
    this._followCharacter(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // キャラがルート移動で画面外へ歩いて行かないよう、注視点をゆるやかに追従させる
  // (カメラの回転・ズームはユーザー操作のまま、平行移動だけ付いていく)
  _followCharacter(dt) {
    const hips = this.vrm?.humanoid?.getNormalizedBoneNode('hips');
    if (!hips) return;
    const pos = hips.getWorldPosition(this._followTmp ??= new THREE.Vector3());
    const target = this.controls.target;
    const dx = pos.x - target.x;
    const dz = pos.z - target.z;
    if (Math.hypot(dx, dz) < 0.05) return;
    const k = Math.min(1, dt * 3); // なめらかな追従
    target.x += dx * k;
    target.z += dz * k;
    this.camera.position.x += dx * k;
    this.camera.position.z += dz * k;
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
    // ルート移動でキャラが原点から離れると、初期位置基準のバウンディング球により
    // フラスタムカリングされて消えるため、スキンメッシュのカリングを無効化する
    vrm.scene.traverse((obj) => {
      if (obj.isSkinnedMesh || obj.isMesh) obj.frustumCulled = false;
    });
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.scene.add(vrm.scene);

    // モデルの身長に合わせてカメラをフレーミング
    const bbox = new THREE.Box3().setFromObject(vrm.scene);
    const height = Math.max(0.5, bbox.max.y - bbox.min.y);
    this.controls.target.set(0, height * 0.55, 0);
    this.camera.position.set(0, height * 0.65, height * 2.1);
    this.controls.update();
    return vrm;
  }

  /**
   * GLB (.vrma) の ArrayBuffer を読み込んで再生する。
   * @param {ArrayBuffer} arrayBuffer
   * @param {boolean} loop
   */
  async playVRMA(arrayBuffer, loop = true, seekTime = 0) {
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
    if (seekTime > 0) action.time = Math.min(seekTime, Math.max(0, clip.duration - 0.001));
    this.currentAction = action;
    return clip.duration;
  }

  stop() {
    this.mixer?.stopAllAction();
    this.vrm?.humanoid?.resetNormalizedPose();
  }

  // --- ウェイポイント (経由地) マーカー ---

  /** キャンバス座標から地面 (y=0) 上のワールド座標を返す。当たらなければ null */
  groundPointFromClick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, hit) ? hit : null;
  }

  /** 経由地の通し番号を表示するビルボードスプライトを作る */
  _makeNumberSprite(n, x, z) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#4ade80';
    ctx.font = 'bold 44px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), 32, 34);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas),
      depthTest: false,
    }));
    sprite.scale.set(0.22, 0.22, 1);
    sprite.position.set(x, 0.28, z);
    return sprite;
  }

  /** 経由地マーカー (番号順に接続線付き) を描画し直す */
  setWaypointMarkers(points) {
    if (this._waypointGroup) {
      this.scene.remove(this._waypointGroup);
      this._waypointGroup.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
    }
    this._waypointGroup = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x4ade80 });
    points.forEach((p, i) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.02, 8, 24), mat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(p.x, 0.02, p.z);
      this._waypointGroup.add(ring);
      this._waypointGroup.add(this._makeNumberSprite(i + 1, p.x, p.z));
    });
    if (points.length > 0) {
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0.02, 0),
        ...points.map((p) => new THREE.Vector3(p.x, 0.02, p.z)),
      ]);
      this._waypointGroup.add(new THREE.Line(
        lineGeo,
        new THREE.LineBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.5 })
      ));
    }
    this.scene.add(this._waypointGroup);
  }
}
