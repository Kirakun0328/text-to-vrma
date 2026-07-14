// idleMotion.js — 起動時・モデル読込時に再生する待機モーション (呼吸)
const K = (t, r) => ({ t, r });

export function idleSpec() {
  const d = 4.0;
  return {
    name: 'idle',
    duration: d,
    loop: true,
    tracks: {
      leftUpperArm: [K(0, [0, 0, -70]), K(2.0, [0, 0, -68]), K(d, [0, 0, -70])],
      rightUpperArm: [K(0, [0, 0, 70]), K(2.0, [0, 0, 68]), K(d, [0, 0, 70])],
      chest: [K(0, [0, 0, 0]), K(2.0, [2.5, 0, 0]), K(d, [0, 0, 0])],
      head: [K(0, [0, 0, 0]), K(1.5, [1.5, 3, 0]), K(3.0, [1.5, -3, 0]), K(d, [0, 0, 0])],
    },
    hips: [
      { t: 0, p: [0, 0, 0] },
      { t: 2.0, p: [0, -0.008, 0] },
      { t: d, p: [0, 0, 0] },
    ],
  };
}
