# Text-To-VRMA — VRM特化型Text-To-Motionツール

![デモ: テキストからモーション生成](video/demo.gif)

[🎬 フル画質のデモ動画 (mp4)](video/Tex-To-VRMA.mp4)

テキストを入力すると、OpenAI API がキーフレームを設計し、
**VRMA (VRM Animation / `.vrma`)** ファイルをブラウザ内で生成して、
その場で VRM キャラクターを動かす Web アプリです。
生成した `.vrma` はファイルとして保存でき、VRMA 対応アプリでそのまま利用できます。

例:「その場で歩く」「喜んでジャンプする」「手を振る」「悲しそうにうつむく」

モーションと同時に**表情** (笑顔・悲しみ・驚き・まばたき等) も生成されます。

## 必要なもの

- Node.js 20+
- OpenAI API キー ([platform.openai.com](https://platform.openai.com/) で取得)

VRM モデルは [VRoid 公式サンプルモデル (AvatarSample)](https://hub.vroid.com/characters/2843975675147313744/models/5644550979324015604)
の VRM1.0 版・VRM0.0 版を同梱しており、起動時に VRM1.0 版が読み込まれます。
手持ちの `.vrm` への差し替えも可能です。

VRM **0.x / 1.0 の両形式に対応**しています (three-vrm が自動判別し、向きも正規化)。

## セットアップ & 起動

```sh
git clone https://github.com/Kirakun0328/text-to-vrma.git
cd text-to-vrma
npm install
npm run dev
# → http://localhost:5173 をブラウザで開く
```

## 使い方

1. 起動するとサンプルモデル (AvatarSample VRM1.0版) が読み込まれます。
   「VRMファイルを開く」または 3D ビューへのドラッグ&ドロップで手持ちの VRM に差し替え可能
2. OpenAI API キーを入力し、モデル (gpt-5.6 系) を選択
   - キーはブラウザの localStorage にのみ保存され、OpenAI 以外には送信されません
3. テキストを入力して「▶ モーション生成 & 再生」 (Ctrl+Enter でも可)
   - 「🔍 自己修正」ON (デフォルト) では生成後にもう1パス、可動域・軌道・緩急の
     セルフレビューを行い品質を上げます (API呼び出しが2回になります)
4. 「⬇ .vrma 保存」で生成アニメーションをファイルに書き出し

## デスクトップ版 (exe) のビルド

Booth 等で配布できる Windows ポータブル exe を生成できます:

```sh
npm run app:build
# → release/Text-To-VRMA-v<version>.exe (単一ファイル、インストール不要)
```

- exe に API キーは一切含まれません。利用者が起動後に自分の OpenAI API キーを
  入力する方式で、キーは利用者の PC 内にのみ保存されます
- 同梱されるのはビルド済みアプリと AvatarSample モデルのみです

## アーキテクチャ

```text
テキスト ── OpenAI API ──▶ モーション spec (ボーン別オイラー角キーフレーム JSON)
                                   │
                                   ▼
              vrmaBuilder.js ── glTF + VRMC_vrm_animation 拡張 → GLB (.vrma)
                                   │
                                   ▼
              viewer.js ── three.js + @pixiv/three-vrm-animation で VRM に再生
```

| ファイル | 役割 |
| --- | --- |
| `src/llm.js` | OpenAI API へのプロンプト (ボーン規約・お手本モーション5種) / 2パス自己修正 / spec 検証・角度クランプ |
| `src/vrmaBuilder.js` | モーション spec から VRMA (GLB) をバイナリ生成。VRM1 規約の T ポーズ骨格を埋め込み、`VRMC_vrm_animation` 拡張でヒューマノイドボーンをマッピング |
| `src/viewer.js` | three.js シーン / VRM ロード / VRMA 再生 |
| `src/idleMotion.js` | 待機モーション (呼吸) |
| `src/main.js` | UI 結線 |

## モーション spec フォーマット

LLM が生成する中間表現です:

```json
{
  "name": "wave",
  "duration": 2.6,
  "loop": true,
  "tracks": {
    "rightUpperArm": [
      { "t": 0, "r": [0, 0, 70] },
      { "t": 0.4, "r": [0, 0, -45] }
    ]
  },
  "hips": [ { "t": 0, "p": [0, 0, 0] } ]
}
```

- `r` = T ポーズからのオイラー角 [X, Y, Z] (度) / `p` = 腰位置オフセット (m)
- `expressions` で VRM プリセット表情 (happy / angry / sad / surprised / blink 等) の
  ウェイト (0〜1) もアニメーションできます
- 座標規約: モデルは +Z 正面 / +X が左手側 (VRM 1.0 準拠)

## 開発者

- X (Twitter): [@Kiratchi0328](https://x.com/Kiratchi0328)

## ライセンス / 注意

- コード: MIT License
- 同梱の AvatarSample モデル (© pixiv / VRoid) は **MIT ライセンスの対象外**です。
  [VRoid の利用条件](https://vroid.pixiv.help/hc/en-us/articles/4402394424089-VRoidPreset-A-Z)
  に従ってください (無償利用・再配布可 / **有償での再配布と CC0 としての配布は禁止**)
- その他の VRM モデルは各モデルの利用規約に従ってください
- 生成される `.vrma` の利用は各自の責任で行ってください
