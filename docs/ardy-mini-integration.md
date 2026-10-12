# ARDY-mini: optional native integration and distribution boundary

The application remains MIT-licensed. ARDY-mini source is Apache-2.0; that
license does not relicense external checkpoints. See the publisher's
[third-party model notice](https://github.com/intsuc/ardy-mini/blob/main/THIRD_PARTY_MODELS_AND_DATA.md)
and [model terms](https://huggingface.co/intsuc/Llama-3-ARDY-Mini-Core40-Browser/blob/1c21362effeecec0454bfc0d818661525ae6b387/MODEL_TERMS.md).

The published distilled conditioner carries Meta Llama 3 teacher lineage,
MiniLM Apache-2.0 terms, and the publisher's composite model terms. The native
ARDY checkpoint carries NVIDIA Open Model terms. Keeping weights outside the
repository prevents accidentally relicensing or bundling them; it does not
remove the terms governing their use. Source publication and unrestricted
model redistribution are separate questions. Publisher notices are not a
legal guarantee of upstream training rights. In particular, Meta's restrictions
on using outputs to improve another large language model warrant review before
redistributing a distilled model; this integration does not decide that legal
classification.

No weights are in the source tree/package: experimental downloads are under
git-ignored `release/`. The source default remains the original encoder;
`--mini-encoder` explicitly selects the Mini path. The local development
server can run that path at 2337 without changing the app URL at 5173.

The existing public repository's `master` at
`b8081875916c8621c7ec226b4adcb2c70e7b13b7` was checked: its third-party notices
already separate model weights from MIT source, and its Windows installer
downloads ARDY from Hugging Face. Mini follows this distribution boundary.
Its downloader displays the model-terms URL before downloading and retains
the license package locally. Packaging explicitly excludes ONNX and PyTorch
weight files as an additional guard. These local changes are not yet pushed.

## Implementation

`tools/ardy-engine/mini_encoder.py` uses the published CPU ONNX conditioner
with the existing native Core40 denoiser. It retains body/root constraints,
eight inference steps, streaming, Jev and Astra design. It does not port the
browser demo's unconstrained denoiser. Bias-free root/body conditions are
selected independently; original CFG biases are retained. The official
checkpoint hash and loaded projection weights are checked for compatibility.
Overlength captions fail explicitly instead of silently dropping later actions.

Setup (separate model terms apply):

```powershell
& C:/text-to-motion-ardy-poc/venv/Scripts/python.exe -m pip install --target release/mini-python --no-deps onnxruntime==1.24.3
& C:/text-to-motion-ardy-poc/venv/Scripts/python.exe tools/setup_ardy_mini.py
powershell -File tools/start_ardy_mini.ps1 -Port 2338
```

Existing Python supplies numpy, torch and tokenizers. Downloads are pinned to
`1c21362effeecec0454bfc0d818661525ae6b387` and SHA-256 checked. The launcher
does not stop another server. Electron also accepts `ARDY_MINI_ENCODER` or the
existing engine config's `miniEncoder` path, with onnxruntime installed in that
Python environment. Default behavior is unchanged.

## Comparison

Two saved Astra plans, same seed 42, native Core40 and eight steps in both
paths. No fresh Astra planning time is included. Each case ran once, so these
are observations, not statistical performance guarantees.

| Case | First VRMA legacy / mini | Mean chunk request legacy / mini |
| --- | --- | --- |
| Walk then jump | 755 / 730 ms | 447 / 343 ms |
| Pick up then offer | 736 / 246 ms | 535 / 242 ms |

Both paths completed and preserved played prefixes. Browser pose inspection
shows broadly corresponding actions but changed motion trajectories; the
distilled encoder is not numerically equivalent to the teacher. Fine contact,
final poses and general prompt fidelity are not guaranteed. Mini does not
shorten Astra's own planning latency. Results are in
`release/mini-compare-legacy-v2` and `release/mini-compare-fast-v2`.

259 JavaScript tests and 60 Python tests passed, including direct-conditioning
projection equivalence and preservation of unconditional CFG bias.
