# ローカルHTTP APIでCodexのサブスクを使う

`npm install` の後、`npm run api` で起動。Codexには事前にChatGPTでログインする。
Web版のログインも同じCLI認証を利用する。APIキーへの自動フォールバックはない。

## 速度優先のキーフレーム生成

`POST http://127.0.0.1:8787/v1/motions`、Content-Typeはapplication/json。
トークンを設定したサーバーではAuthorization: Bearerも付ける。

```json
{
  "engine": "codex",
  "model": "gpt-6-astra",
  "prompt": "自然に一度お辞儀する",
  "speed": "fast",
  "format": "json"
}
```

`speed` は `fast` / `balanced` / `quality`。CodexとOpenAIで指定できる。
fastは推論量とキー数を抑え、refine省略時は自己修正を行わない。
refine:trueを明示すればfastでも自己修正する。speed省略時は従来の動作を維持。
`format: "vrma"` ならVRMAバイナリを返す。

Codexはサブスクの利用枠を消費する。OpenAIを選択するとAPI料金になる。
既存クライアント互換のため、engineを省略したHTTPリクエストは従来どおりopenai。
サブスクで使うときは `engine: "codex"` を明示する。

## ARDYの頭脳を選ぶ

```json
{
  "engine": "ardy",
  "planner": "codex",
  "model": "gpt-6-astra",
  "prompt": "歩いてから手を振る",
  "duration": 5
}
```

plannerはcodex（既定）、openai、claude、none。OpenAI/ClaudeにはそれぞれのAPIキーが必要。
計画に失敗した場合は原文でARDY生成を続ける。別の有料プロバイダへ自動切替しない。
ARDYは事前に起動する。身体の生成速度はARDYモデルと実行デバイスによる。

## Web画面との違い

このHTTPエンドポイントは、テキストからモーションJSONまたはVRMAを返す。
読み込んだVRMの自動撮影・画像レビュー・初稿の先行再生はWeb/デスクトップ画面側の機能。
HTTPの返却は生成完了後。リアルタイムのフレーム配信や画像レビューには対応していない。

速度優先でも初回応答の時間はモデル、指示、利用状況によって変わり、秒未満の応答は保証しない。
