# Text-To-VRMA — VRM-Specialized Text-To-Motion Tool

[![GitHub Sponsors](https://img.shields.io/badge/♥_Sponsor-Support-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/Kirakun0328)

![Demo: Motion Generation from Text](video/demo.gif)

A web application where you enter text, and AI generates motion, creating a **VRMA (VRM Animation / `.vrma`)** file directly within your browser to animate your VRM character on the spot. The generated `.vrma` files can be saved and used directly in any VRMA-compatible application.

Examples: "walk in place", "jump with joy", "wave hand", "look down sadly"

## ✨ Key Features
- 📝 **Text-to-Motion Generation** (Japanese supported) — Powered by two engines: LLM Keyframe / NVIDIA ARDY
- 🧠 **Jev (TypeSafe AI) Support** — Analyzes emotion, gaze, and movement tempo from input text, automatically supplementing facial expressions and movement styles (v1.1.9+)
- 🚀 **Latest Model Support** — OpenAI GPT-6 generation (`gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna`), and Claude Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5
- 💳 **Codex Subscription Support** — In addition to the desktop version, you can utilize your quota directly from the local web version
- 🎬 Export generated motion as **GIF / Video (1080p)** — Share directly on social media
- 🎨 **Custom Background Colors** — Set solid background colors for chroma key compositing (e.g., green screen)
- ⏱ **Specify Motion Length in Seconds** (leave blank for auto-detection, with an "auto-correction" option)
- ▶ **Playback Seekbar** — Displays current seconds, scrub to any point, and pause
- 📍 **Waypoint Mode** — Click on the 3D view floor to specify movement paths (ARDY)
- 🎭 **Physical Expression of Emotion** — Reflects not just facial expressions, but also posture, arms, center of gravity, and movement dynamics
- 🔍 **AI Motion Review** — AI evaluates necessity after generation and applies corrections only when needed
- 🎯 **Instruction-Following Check** — Measures movement, jumping, crouching, and hand-raising on the avatar
- 🎲 **Generate and Compare 3 Candidates** — Generate with different seeds to compare and choose the best one
- ✨ **Full-Body Smoothness Correction** — Softens abrupt angle changes while preserving grounding areas
- 🔁 **Loop Playback** — Connects the beginning and end for seamless playback
- 😊 **Automatic Facial Expression Generation** + 4-Language UI (Japanese / English / Chinese / Korean)
- 🔌 **OpenAI-Compatible Provider Support** — OpenRouter, DeepSeek, Ollama, and more can also be used
- 🟣 **Claude API Support** — Generate motions using Anthropic's Claude (claude-opus-5-5, etc.)
- 🧭 **Connection Guidance** — If connection fails (e.g., when the ARDY engine is not running), it displays the cause along with buttons like "Start Engine"



You can choose from two generation engines:

| Engine | Features | Requirements |
| --- | --- | --- |
| **LLM Keyframe** (OpenAI API / Claude API / Codex / Compatible APIs) | Excels at precise pose, finger, and facial expression specification. Works on any PC with no setup required. Supports OpenAI-compatible APIs (OpenRouter, DeepSeek, Ollama, etc.) as well as Anthropic's Claude API. | API Key or Codex Plan |
| **ARDY Local Engine** (v1.1+) | Locally runs NVIDIA's motion generation AI [ARDY](https://github.com/nv-tlabs/ardy). Full-body movements like walking, dancing, and jumping are of **motion capture quality**. Unlimited generation, works offline. | Additional setup (see below) |

In ARDY mode, ARDY generates the physical motion. When combined with Codex, it designs the body and facial expressions for the initial movement segment before starting generation and playback, designing subsequent segments concurrently. It preserves the timestamps and contents of finalized segments and appends them to the end. "ARDY Only" generates directly from the input text. Jev's analysis is used concurrently as an auxiliary tool. Standard new generations are independent, and during generation, re-inputs or explicit additive corrections seamlessly connect from the current physical history. For operations and constraints, please refer to [ARDY Continuous Generation](docs/ardy-realtime.md).

| Motion-Planning AI | Requirements | Notes |
| --- | --- | --- |
| **ARDY Only** (Default) | None | Generated using ARDY's built-in translation. |
| **Codex Subscription** | ChatGPT / Codex Plan | Displays usage rate, remaining quota, and reset time in the settings panel. |
| **OpenAI API** | API Key | GPT-6 Astra / GPT-6.1 Sol (Default) / GPT-6 Luna |
| **Claude API** | API Key | Fable 5.1 / Opus 5.5 (Default) / Sonnet 5.5 / Haiku 5.5 |

- If authentication or planning fails during continuous generation using Codex, the reason will be displayed. It will not automatically switch to ARDY Only or paid APIs. Direct generation can be selected via "ARDY Only".
- For post-generation review and quality settings, please refer to [How Motion Quality Works](#how-motion-quality-works).

Simultaneously with the motion, **facial expressions** (smiles, sadness, surprise, blinking, etc.) are also generated. 
Blink intervals have natural variations and are suppressed during surprised expressions.
When saving the `.vrma` file, you can choose whether to "Include / Exclude facial expressions (bone motion only)".

The UI is available in **Japanese / English / Chinese / Korean** — switch instantly via the selector in the top-right corner.
(Automatically determined from browser language settings on first launch).
*The UI is available in Japanese, English, Chinese and Korean — switch instantly from the selector at the top.*





## Setup & Startup

> 🎁 **For Windows users who want to use it without building:**
> [Download the latest zip from Releases](https://github.com/Kirakun0328/text-to-vrma/releases/latest)
> — Just extract it and double-click the exe (no installation required; a complete ARDY engine setup is also bundled).
> All of the setups below are unnecessary.

If running from source, there are two ways. If you are unsure, **A. Browser Version** is the fastest.

| | Startup Command | Best For |
| --- | --- | --- |
| **A. Browser Version** | `npm run dev` | Those who want to try it first (All OSs, shortest 3 commands) |
| **B. Desktop Version (Electron)** | `npm run build` → `npm run app:dev` | Those who want to use Codex subscription authentication, or in-app setup and auto-startup of the ARDY engine |

**Prerequisites:**

| What to do | Requirements |
| --- | --- |
| Common | Node.js 20+, git |
| Motion Generation (LLM Keyframe) | OpenAI API Key (obtained from [platform.openai.com](https://platform.openai.com/)) or Claude API Key (obtained from [console.anthropic.com](https://console.anthropic.com/)). Alternatively, Codex and a ChatGPT/Codex plan can be used for the local web and desktop versions. |
| ARDY Local Engine (Optional) | See the [ARDY Local Engine section](#ardy-local-engine-optional) below (Python 3.10+ / git, approx. 20GB download). **This can run without an API key.** |

The VRM model includes the VRM 1.0 and VRM 0.0 versions of the [VRoid Official Sample Model (AvatarSample)](https://hub.vroid.com/characters/2843975675147313744/models/5644550979324015604), and the VRM 1.0 version is loaded on startup. You can also swap it out for your own `.vrm` files, as **both 0.x and 1.0 formats are supported** (three-vrm automatically detects them and normalizes the orientation).






### A. Browser Version

```sh
git clone https://github.com/Kirakun0328/text-to-vrma.git
cd text-to-vrma
npm install
npm run dev
# → Open http://localhost:5173 in your browser
```

### B. Desktop Version (Electron)

```sh
git clone https://github.com/Kirakun0328/text-to-vrma.git
cd text-to-vrma
npm install
npm run build
npm run app:dev
```



- The Electron version loads the Vite build output (`dist/index.html`). For the initial run and after source code changes, **make sure to run `npm run build`** before starting with `npm run app:dev` 
  (if you are just restarting with an already built version, `npm run app:dev` alone is fine).
- Codex subscription authentication is available in the desktop version and the local web version (`npm run dev` / `npm run preview`).

  To use it, please make sure to install, authenticate, and configure the PATH for the Codex CLI beforehand 
  (the Codex CLI is not bundled with the app).
  If it is missing or outdated, the app will display instructions for installation and updates 
  (verified with v0.153.3).
  The local web version connects to `codex app-server` via the same-origin Node server.
  It cannot be used when serving static files only. The model list is fetched from the logged-in account, and if GPT-6 Astra is not listed, it cannot be selected on the subscription side yet.
  Running `npm install` on the source version also installs the verified Codex CLI 0.153.3.
  It prioritizes the CLI within the project, and only falls back to the PATH CLI if it does not exist.
  Older CLIs may not list available Astra models (verified in 0.144.1 and 0.153.3).

> [!NOTE]
> The current `npm run app:build` (exe generation) is exclusively for the Windows Portable version. It does not generate `.app` or `.dmg` files for macOS.

## Usage

1. Upon startup, the sample model (AvatarSample VRM 1.0 version) is loaded.

   You can swap it out for your own VRM by clicking "Open VRM File" or dragging and dropping onto the 3D view.
2. Select the generation engine
   - **OpenAI API Key**: Enter your key and select a model. The key is stored only in the browser's 
     localStorage and is never sent to anyone other than OpenAI.
     By specifying a base URL and model name via "🔌 Use OpenAI-compatible provider", 
     you can also use compatible APIs such as OpenRouter, DeepSeek, or Ollama.
     You can also select **GPT-6 Astra** (`gpt-6-astra`) from the model list.
     It can be used for generation, self-correction, and ARDY's motion planning; the default model is `gpt-6.1-sol`.
     According to the [Official OpenAI Model Information](https://developers.openai.com/api/docs/models/gpt-6-astra), 
     it is rolling out gradually, so your API project must have access rights.
     For local HTTP APIs, you can specify `gpt-6-astra` for the request `model` 
     or set the environment variable `OPENAI_MODEL=gpt-6-astra`.
   - **Claude API**: Enter your Anthropic Claude API key (`sk-ant-...`) and select a model 
     (`claude-fable-5-1` / `claude-opus-5-5` / `claude-sonnet-5-5` / `claude-haiku-5-5`).
     The key is stored only in the browser's localStorage and is never sent to anyone other than Anthropic.
     Claude API support is contributed by [@AUDOSt0ck1ng](https://github.com/AUDOSt0ck1ng) 
     ([#9](https://github.com/Kirakun0328/text-to-vrma/pull/9)), and **while contributors have verified it works in both browser and desktop versions, it has not been verified in the author's environment**.
     Bug reports and operation feedback are welcome.
   - **Codex Subscription (Desktop & Local Web Version)**: Click "Login with ChatGPT" 
     to authenticate in your default browser. If you are already logged in via the Codex CLI, that authentication is reused.
   - **ARDY Local Engine**: Motion generation AI running locally (see section below)
3. Direct the movement with text and click "▶ Generate & Play Motion" (Ctrl+Enter is also available)
   - You can specify the motion length using "⏱ Length (sec)" (leave blank for auto-detection).
   - Turning on "Auto-correct length" automatically adjusts it to a natural length appropriate for the number of actions.
   - Under "Loop Playback", you can choose Automatic / Always Loop / Play Once.
   - "🔍 Self-Correction" (LLM mode) runs an additional pass after generation to improve quality.
   - **Acting Design + Image Review**: Available with Codex (subscription quota) or the official GPT-6 Astra API.
     Plans acting cues, support leg, center of gravity, gaze, and limb arrival positions, generating using the actual dimensions of the loaded VRM.
     Sends front and side stop-motion images and measured positions back to the model, correcting once (total of 3 generations).
     API mode is pay-per-use, Codex mode requires a ChatGPT login and does not automatically switch to an API key.
     Supports 1 to 15 seconds. Executed in place of "Regular Self-Correction".
     In the post-completion comparison panel, you can play back before/after correction and review the acting design, measured values, and sent images.
     Candidates with significantly worsened metrics are not auto-selected, but are kept for comparison. Measured values do not guarantee physical quality.
     "Speed Priority" limits reasoning volume and key count, while "Quality Priority" thinks more thoroughly.
     Plays the first draft first before correction completes. Displays the time until the first draft and total time in the comparison panel.
4. The generated movement is played back in the 3D view
   - You can check the current seconds, scrub to any point, and pause using the **playback bar** at the bottom.
   - Adjust the preview using **Reset Camera / Fullscreen** at the top right and **Switch Background** at the bottom.
5. Export from "4. Export & Share"
   - **⬇ Save .vrma** — A file usable in VRMA-compatible apps (VRoid Hub, cluster, etc.)
   - **🎞 Export GIF / 🎬 Export Video** — Export in 1080p and share directly to social media
   - You can also play, save, and export GIF/video from each item in the generation history.



## How Motion Quality Works

Rather than outputting generated motions as-is, quality is enhanced across multiple stages.
Please note that all of these are **auxiliary measures based on geometric measurements and do not guarantee quality**.

### Generation Quality

You can choose from "Standard", "Speed Priority", and "Quality Priority" (Standard is the default).
This changes the amount of inference and the number of review iterations during planning. Speed priority limits inference, while quality priority thinks through things thoroughly and performs re-evaluations up to 2 times.

### End-Pose Preservation

In continuous generation, body parts that should not move in each segment are fixed. Arms that were resting down are kept hanging in the direction of gravity even if the torso tilts, and in segments ending with "lowering arms", only the arms that are still raised are moved. Segments starting in mid-air animate the up-and-down movement of the legs and hips to land.
For details, please refer to [End-Pose Preservation](docs/end-pose-holding.md).

### AI Motion Review

After generation, the AI **first determines whether correction is necessary**. If not, the original movement is adopted as-is, and the reason is displayed in the preview's "Compare Before/After Correction".

- **Standard & Quality Priority** — Applies corrections directly to the joints of the original motion and re-evaluates them using a separate judgment.

- **Speed Priority** — Reviews instructions sent to ARDY and regenerates.

- **Use Images Too** — The app automatically captures front and side photos of the generated motion and sends them to the selected AI.

  (Users do not need to prepare reference images themselves.)

Auto-correction is OFF by default. You can execute it manually after generation via "Correct this motion".
If physical metrics worsen or requested actions disappear, it will not be auto-adopted.
ARDY's end-pose is preserved, and forced upright interpolation that causes foot sliding is avoided.

| | |
| --- | --- |
| Supported Length | 1 to 15 seconds (Feature available in Web and Desktop versions) |
| Information Passed to AI | Foot sliding, joint angular velocity, limb velocity, and acceleration |
| How Foot Sliding is Measured | Approximates ground contact from foot height and vertical velocity. **This is not a physical simulation or full-body collision detection.** |

### Instruction-Following Check

Detects four types of movements—locomotion, two-footed jumping, lowering hips, and raising hands near the face—by measuring joint positions on the avatar at up to 20Hz.

This is a **geometric proxy metric**. It does not guarantee strict step counts, movement directions, action order, facial expressions, naturalness, collisions, or physical stability.

### Generate and Compare 3 Candidates

If you want to compare, you can generate 3 candidates using different seeds and compare them side-by-side (normally 1 candidate).
When comparable checks are available, detection count is prioritized, and foot sliding and sinking are also checked.
While this does not trigger additional AI planning calls, ARDY's generation time increases.


### Full-Body Smoothness Correction

Softens sudden angle changes (ON by default, found in "Detailed Motion Settings").
In addition to the arms and upper body, this also targets the legs, ankles, hips, and fingers.

Ground contact is estimated from ankle height, and **correction is reduced in lower foot segments to maintain the movement path**.
This is an estimation based on ankle height, not an IK fix measuring actual avatar sole contact.
It does not guarantee ground contact judgment on stairs, steps, or special postures, nor does it completely prevent foot sliding.

### Loop Playback

If there is a finite number of repetitions or a concluding motion, it does not loop automatically, but instead holds the final pose.
When explicitly looping, the beginning and end are overlapped and connected.
For loops involving locomotion, position and orientation are accumulated, suppressing the issue of returning to the origin every cycle.

> This transition handling is **for playback within the viewer only**. The same processing is not baked into exported `.vrma` files.

## ARDY Local Engine (Optional)

A mode that runs NVIDIA Research's text-to-motion model 
[ARDY](https://research.nvidia.com/labs/sil/projects/ardy/) (SIGGRAPH 2026) 
locally to generate motion-capture-quality full-body motion.

**What it can do:**

- Generates full-body movements like walking, running, dancing, jumping, and combat using AI trained on actual human motion capture data (center-of-gravity shifts, momentum, and foot contact look authentic).
- **Japanese prompts supported** — Automatically translates into English via local translation (FuguMT). 
  If an OpenAI API key is saved, GPT handles both English translation and splitting continuous actions, improving accuracy.
- **📍 Waypoint Mode** — Click on the 3D view floor to place waypoints, generating motion for the character to pass through in that order (right-click to undo one).
- **Multi-step actions** like "walk, run, jump, and trip" can also be split and verified by GPT, connecting and generating up to 12 actions (when an API key is saved).
- Motion length can be specified in seconds (0.1s+) or automatically determined from content. Expressions and loop availability are also automatic.
- Unlimited generations, completely local (runs offline after setup).


**System Requirements & Performance:**

| | Minimum | Recommended |
| --- | --- | --- |
| OS | Windows 10/11 64-bit, macOS, Linux | Same as left |
| RAM | 16GB | 32GB+ |
| Disk | 35GB | Same as left |
| GPU | VRAM 4GB+ (or CPU, taking a few dozen seconds per generation) | NVIDIA GPU 6GB+ (a few seconds per generation) |

> 💡 **While the official ARDY demo requires 20–24GB of VRAM, this app reduces the VRAM usage of the motion model itself to approximately 1.2GB in actual measurements** (because the 8B LLM text-understanding component, which accounts for most of the VRAM, runs on the CPU side). VRAM hardly increases during generation either (actual measurement: +approx. 12MiB).
> Since the motion model itself and the number of diffusion steps remain identical to the official version, **generation quality is not compromised at all**.
> * Figures are actual measurements via `nvidia-smi` (VRAM difference between process stop/start).
> Since model usage is around 1.2GB and does not increase during generation, adding desktop display overhead means it is **expected to run sufficiently on a GPU with 4GB of VRAM** (verified on 12GB; 4–6GB is untested, so 6GB+ is recommended).
> Even without a GPU, it runs on the CPU (though generation will be several times slower).

**3-Layer Architecture Supporting Quality** — Division of roles: "GPT is the brain, ARDY is the body":

| Layer | Role |
| --- | --- |
| GPT (Optional / When API key is saved) | Japanese intent understanding, splitting continuous actions, rephrasing into English expressions that ARDY handles well |
| Llama-3-8B (Local / CPU) | Converts English text into ARDY-specific vectors (LLM2Vec) |
| ARDY (Local / GPU) | Generates movement using AI trained on actual motion capture data |

Everything can be completed via local translation (FuguMT) even without an API key, but having a key improves the reproduction accuracy of complex instructions like "run, then jump, and finally bow".

**Setup** (Requires Python 3.10+ and git; downloads approx. 20GB):

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File tools\ardy-engine\install.ps1
```

macOS:

```bash
bash tools/ardy-engine/install_mac.sh
```

Linux:

```bash
bash tools/ardy-engine/install_linux.sh
```

The Linux version supports `apt`, `dnf`, `yum`, `pacman`, and `zypper`, and automatically installs Python 3.10+, git, and C++ build tools (`gcc`/`g++`, `cmake`) as needed (using `sudo` for package installations).
If an NVIDIA GPU is present, it automatically selects the CUDA version of PyTorch (determined via `nvidia-smi`).
When using it from the browser version, please start the engine manually using the `server.py` startup command displayed upon completion of the setup.

If Homebrew is not installed on macOS, it will be automatically installed during setup.
macOS support is contributed by [@emadurandal](https://github.com/emadurandal) ([#2](https://github.com/Kirakun0328/text-to-vrma/pull/2)), and Linux support is contributed by [@mouseos](https://github.com/mouseos) ([#7](https://github.com/Kirakun0328/text-to-vrma/pull/7)).
**The developer (author) has only verified functionality on Windows; macOS and Linux have not been verified in the author's environment**
(macOS and Linux have been verified on real hardware by their respective contributors).
Bug reports, operational feedback, and pull requests for fixes on these environments are welcome.

After completion, start the engine and select the "ARDY Local Engine" mode in the app.
For details, manual startup, and APIs, please refer to [tools/ardy-engine/README.md](tools/ardy-engine/README.md).

This feature uses Meta Llama 3 as its text encoder. **Built with Meta Llama 3**

## Meaning and Emotion Analysis via Jev (TypeSafe AI) (Optional)

[Jev](https://typesafe.ai/) is TypeSafe AI's "System One Model". Unlike LLMs that generate text, it is a model that rapidly classifies input sentences into typed choices and scores.
In Text-To-VRMA, **Jev does not create the motion itself**. Its role is strictly to analyze:

- The emotion of the input text (`emotion`) and its intensity (`emotion_intensity`)

- Independent scores for each emotion (`affect`) and item-by-item confidence (`confidences`)

- Energy volume (`movement_energy`), scale of movement, tempo, interpersonal attitude, and specified gaze

and pass those results **as auxiliary information** to the generation prompt (common across ARDY, OpenAI, Claude, and Codex). It prioritizes the original text and does not fix the type of action. The legacy classification `reaction` is for analysis API compatibility and is not passed to physical generation. Independent emotion scores are also used for preliminary facial expressions; if ARDY's face is undesigned, it is interpolated into VRMA as a brief opening expression.
Existing expression tracks and mid-stream emotional shifts are preserved.

**If you have a Jev API key, it will be used automatically.** If unconfigured, in case of an error, or upon timeout, generation continues without Jev. Even if overall confidence is low, the entire analysis is not discarded; it is handled according to the confidence of each item.
In continuous generation combined with Codex, segment design and Jev analysis run concurrently, and ARDY starts once the initial body and facial expression segments are finalized.
Subsequent plans are appended to the end, and later-arriving Jev analyses are passed to the generation conditions of unplayed segments. They do not overwrite already played movements or expressions designed by Codex.

### How to Enable It

- **App / Browser Version**: Enter your Jev API key in the Settings field (located to the left of the language selector, in the same row as other API keys) and select a model (`jev-latest` / `jev-preview` / `jev-1.13.0`). Changes are saved automatically.
- **Local HTTP API (`npm run api`)**: Set `JEV_API_KEY` in your `.env` file. 
  You can explicitly disable the server globally by setting `JEV_ENABLED=false` (see `.env.example`).

### Japanese is Translated into English Before Analysis

Jev primarily targets English, and TypeSafe AI documentation notes that accuracy drops for other languages. Therefore, Japanese inputs are first translated into English using the translation model (FuguMT) built into the ARDY engine before being sent to Jev. If the ARDY engine is not running or the translation does not finish within 2 seconds, the original text is sent as-is, just like before. You can turn this off via "Translate to English before sending to Jev" in the settings 
(or via environment variable `JEV_TRANSLATE=0` for the local HTTP API). Action-planning AIs (such as Astra or Claude) receive the Japanese text as-is.

### Handling of API Keys

Following the same policy as OpenAI and Claude keys. In the app, keys are saved in `localStorage` and sent to Jev (`https://api.typesafe.ai`) via Electron IPC or a same-origin local connection server. There is no hardcoding in the source code, and they are not output to logs (analysis result logs retain only emotions, reactions, and confidence levels, omitting API keys and full input text).



### Usage from the Local HTTP API

`use_jev` in `POST /v1/motions` is an optional boolean. When omitted, it is used automatically if a key exists on the server, and if `false`, analysis is skipped for that request only.

```bash
curl -X POST [http://127.0.0.1:8787/v1/motions](http://127.0.0.1:8787/v1/motions) \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Yay! It is finally finished!!","engine":"ardy","use_jev":true}'
```

If you only want the analysis results (without generating motion), you can use the dedicated endpoint.

```bash
curl -X POST [http://127.0.0.1:8787/v1/motion-context](http://127.0.0.1:8787/v1/motion-context) \
  -H "Content-Type: application/json" \
  -d '{"text":"Eh!? Really!?"}'
# => {"emotion":"surprise","emotion_intensity":0.8,"reaction":"startled", ...}
```


`use_jev` will only function when `JEV_API_KEY` is configured on the server side and has not been explicitly disabled; requests cannot pass an API key or override the administrator's configuration. Existing Host/Origin/token verifications apply equally to these two endpoints.

### Regarding Network Communication

When Jev is enabled, the input text (truncated to a maximum of 2,000 characters) is sent to the TypeSafe AI API (`https://api.typesafe.ai`). New generations do not send previous acting states.
Explicit additive corrections also pass limited states of the current movement, posture, expression, and playback position.

Routing, late arrival, and confirmation of application to the physical body are recorded in `jevContext`, `jev`, and `realtime.jev` within the generation spec.
For routing and constraints, please refer to [Integration of Jev into the Generation Pipeline](docs/jev-generation-integration.md).

## Architecture



```text
[LLM Keyframe Mode]
Text ── OpenAI API / Codex CLI ──▶ Motion Spec (Bone-specific Euler angle keyframe JSON)

[ARDY Mode]
Text ── Selected AI (Acting Planning & Action Splitting) ──▶ ARDY Engine Server (localhost:2337)
            │  Codex / OpenAI / Claude         │ Generates 20fps motion via diffusion model
            └ No AI -> ARDY Built-in Translation │ → Foot Slide Correction → VRM Retargeting
                                               ▼
                                     Motion Spec ──▶ Smoothness Correction ──▶ AI Review (Optional)
```

From the spec onward, both modes are common:

```text
                         Motion Spec
                              │
                              ▼
              vrmaBuilder.js ── glTF + VRMC_vrm_animation Extension → GLB (.vrma)
                              │
                              ▼
              viewer.js ── Plays back on VRM using three.js + @pixiv/three-vrm-animation
```



| File | Role / Description |
| --- | --- |
| `src/llm.js` | Prompts to OpenAI API (bone conventions / 5 sample motions) / 2-pass self-correction / spec validation & angle clamping |
| `src/vrmaBuilder.js` | Generates VRMA (GLB) binaries from motion specs. Embeds T-pose skeletons for VRM 1 conventions and maps humanoid bones using the `VRMC_vrm_animation` extension |
| `src/viewer.js` | three.js scene / VRM loading / VRMA playback |
| `src/idleMotion.js` | Idle motion (breathing) |
| `src/main.js` | UI wiring |
| `src/autoExpressions.js` | For ARDY mode: Automatic facial expression assignment from emotional words + blinking (supports mixed emotions and time-ordered emotions) |
| `src/emotionActing.js` | Common guidelines for reflecting emotions into physical movements (shared across planning, generation, and review) |
| `src/smoothMotion.js` | Full-body smoothness correction. Estimates ground contact from ankle height and suppresses correction near ground contact |
| `src/motionCompliance.js` | Instruction-following check. Measures movement, jumping, crouching, and hand-raising on the avatar |
| `src/ardyCandidates.js` / `src/candidatePanel.js` | Generation, comparison, and selection of 3 candidates |
| `src/motionReview.js` / `src/ardyReview.js` | Post-generation AI review (including judgment on whether correction is necessary) |
| `src/directMotionReview.js` / `src/motionPatch.js` | Pathway for direct joint correction, along with its application and verification |
| `src/segmentedReview.js` | Splits long actions into ~15-second segments for correction |
| `src/motionAssessment.js` | Calculation of physical metrics such as foot sliding and sinking |
| `src/reviewCapture.js` | Automatically captures front and side views of the generated motion (for image review) |
| `src/motionCheckPanel.js` / `src/reviewI18n.js` | Display and internationalization of playback state, generation path, and check results |
| `src/loopPlayback.js` | Handles connecting the start and end during loop playback |
| `src/codexWebBridge.js` / `src/codexUsage.js` | Codex connection and quota display for the local web version |
| `tools/codex-web.mjs` | Vite dev server plugin that relays requests to `codex app-server` |
| `electron/codex-client.cjs` | Codex app-server connection / ChatGPT authentication / model retrieval / generation in temporary threads |
| `electron/ardy-client.cjs` | Starts and monitors the ARDY engine server (desktop version) |
| `electron/preload.cjs` | Limited IPC bridge that does not expose authentication credentials |
| `src/apiServer.js` | Core local HTTP API (supports both OpenAI and ARDY engines) |
| `tools/api-server.mjs` | API server startup entry (`npm run api`) |
| `tools/ardy-engine/server.py` | ARDY resident server: generation, Japanese translation, waypoint constraints, progress API |
| `tools/ardy-engine/retarget.py` | ARDY Core skeleton → VRM Humanoid retargeting |
| `tools/ardy-engine/install.ps1` | One-command engine setup (Windows) |
| `tools/ardy-engine/install_mac.sh` | One-command engine setup for macOS |
| `tools/ardy-engine/install_linux.sh` | One-command engine setup for Linux |


## Motion Spec Format
This is the intermediate representation generated by the LLM:

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

- `r` = Euler angles [X, Y, Z] (degrees) from the T-pose / `p` = Hips position offset (meters)
- `expressions` = Weights (0 to 1) for VRM preset facial expressions (happy, blink, etc.).
  They always play back in the preview, and you can choose whether to include them when saving `.vrma` files 
  (requires the playback app to support VRMA expression tracks).
- Coordinate convention: Model faces +Z / +X is on the left-hand side (compliant with VRM 1.0).

## Local HTTP API (Experimental Feature for Developers)

> **This is an experimental feature added in v1.1.7.** Especially for generation via the ARDY engine, 
> verification is limited, and the interface may change in the future.
> **Feedback and bug reports from actual usage are very welcome** —
> please feel free to post them on [Issues](https://github.com/Kirakun0328/text-to-vrma/issues).

This is a local API server designed to invoke Text-To-VRMA from other applications or scripts.
You can send text from Unity, Blender, custom tools, or shell scripts, and receive motion specs or `.vrma` files.


```bash
cp .env.example .env   # First time only. Set OPENAI_API_KEY (not needed if using ARDY only)
npm run api            # Start server at http://127.0.0.1:8787
```

If you place `.env` directly under the repository root, it will be automatically read upon startup (it is not tracked by Git).
When started, it displays which engines are currently available:

```text
Loaded .env
Text-To-VRMA API listening on http://127.0.0.1:8787
  engine=openai : Not configured (Please set OPENAI_API_KEY in .env)
  engine=claude : Not configured (Please set ANTHROPIC_API_KEY in .env)
  engine=ardy   : Available (ARDY-Core-RP-20FPS-Horizon40 / GPU)
```

`engine=ardy` **can be used without an API key** (requires starting the ARDY local engine).
`engine=openai` / `engine=claude` require keys, but do not require ARDY setup.

### Using from the Desktop App (v1.1.7+)

Without using commands, you can enable it from the app's "Advanced Settings → Local HTTP API".
It is **disabled by default** and only opens the port on 127.0.0.1 when checked.

- It uses the OpenAI / Claude keys already configured in the app as-is, so duplicate configuration is unnecessary.
- **An access token is required**. Since it is displayed in the settings field, please specify it on the calling side as `Authorization: Bearer <token>`. Because it remains fixed per installation, external tools only need to configure it once. If compromised, you can invalidate it via "🔄 Regenerate".
- If the port is in use, a notification will be displayed (please specify a different port).

```bash
curl -X POST http://127.0.0.1:8787/v1/motions \
  -H "Authorization: Bearer <token displayed in app>" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"walk forward and wave hand","engine":"ardy","format":"vrma"}' \
  -o walk.vrma
```

### Security

**By default, it listens exclusively on 127.0.0.1**, so it is only accessible from apps on the same PC.
When exposing externally, setting `TEXT_TO_MOTION_API_TOKEN` is mandatory; if unconfigured, it will result in an error upon startup (in which case `Authorization: Bearer <token>` is required for all requests).

| Endpoint | Description |
| --- | --- |
| `GET /health` | Operational status, available engines, and key configuration status |
| `GET /openapi.json` | OpenAPI 3.1 definition |
| `POST /v1/motions` | Generate motion from text |
| `POST /v1/vrma` | Convert existing spec to `.vrma` (no key required) |
| `POST /v1/motion-context` | Analyze meaning and emotion only via Jev (Only when Jev is configured; see below) |

`POST /v1/motions` requests:

| Field | Default | Description |
| --- | --- | --- |
| `prompt` | (Required) | Motion instruction. 1 to 4,000 characters |
| `engine` | `openai` | `openai` / `claude` / `codex` = LLM Keyframe / `ardy` = ARDY Local Engine |
| `planner` | `codex` | `ardy` only: AI used for action planning (`codex` / `openai` / `claude` / `none`) |
| `speed` | — | `openai` / `codex`: `fast` / `balanced` / `quality`. `fast` reduces reasoning volume and key count |
| `format` | `json` | `json` returns spec, `vrma` returns `.vrma` binary |
| `model` | Environment variable | Generative model for `openai`/`claude`, GPT model used for action splitting in `ardy` |
| `refine` | `true` | Two-pass self-correction enabled for `openai` and `claude` |
| `duration` | — | `ardy` only: Generated length in seconds |
| `waypoints` | — | `ardy` only: Movement path `[{ "x": 1, "z": 2 }]` |
| `use_jev` | Automatic when key is set | Analyzes meaning and emotion with Jev and uses it as auxiliary information. `false` disables it per request. If Jev is unconfigured on the server, generation proceeds as usual |

```bash
# Generate with ARDY local engine (No API key required; engine startup required)
curl -X POST http://127.0.0.1:8787/v1/motions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"walk forward and wave hand","engine":"ardy","format":"vrma"}' \
  -o walk.vrma

# Generate with OpenAI API key (OPENAI_API_KEY required at server startup)
curl -X POST http://127.0.0.1:8787/v1/motions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"bow"}'
```

```bash
# Generate with Claude (ANTHROPIC_API_KEY required at server startup)
curl -X POST http://127.0.0.1:8787/v1/motions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"bow","engine":"claude","model":"claude-sonnet-5-5"}'
```

Environment variables: `PORT` (default 8787) / `HOST` (default 127.0.0.1) / `OPENAI_API_KEY` /
`OPENAI_BASE_URL` / `OPENAI_MODEL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` /
`ARDY_URL` (default `http://127.0.0.1:2337`) /
`TEXT_TO_MOTION_API_TOKEN` / `TEXT_TO_MOTION_CORS_ORIGIN` /
`JEV_API_KEY` / `JEV_ENABLED` / `JEV_MODEL` / `JEV_TIMEOUT_MS` /
`JEV_CONFIDENCE_THRESHOLD` (For details, refer to "Meaning and Emotion Analysis via Jev (TypeSafe AI)" below).

To prevent malicious web pages from unauthorized triggering, multiple layers of defense are implemented:

| Countermeasure | Content |
| --- | --- |
| Bind address | 127.0.0.1 only. External exposure requires `TEXT_TO_MOTION_API_TOKEN` |
| Host verification | Returns 403 for non-loopback names (DNS rebinding countermeasure) |
| Origin verification | Validates if present. Returns 403 for external origins |
| Sec-Fetch-Site | Returns 403 for `cross-site` |
| Content-Type | POST requires `application/json` only (returns 415 otherwise) |
| Methods | Returns 405 for anything other than GET / POST / OPTIONS |
| CORS | Does not return headers by default (wildcards are not used) |
| Size limit | Request body 1 MiB |
| Token | Mandatory in desktop version. Enabled via `TEXT_TO_MOTION_API_TOKEN` in CLI as well |

It is locked in by tests that API key values are never included in responses.
However, please note that **anyone who can reach the API can "use" it without seeing the key**
(generation will run, consuming usage quotas). This is why tokens are mandatory in the desktop version.

> `TEXT_TO_MOTION_CORS_ORIGIN` configuration is required **only when calling from a web page on a browser**
> (since CORS headers are not returned by default, the browser side will block it).
> There are no restrictions for out-of-browser clients such as curl, Python, Unity, or Node.

## Notes / Disclaimers

- **Verified Environment: Windows 11** (Setup scripts are provided for macOS / Linux, but development verification by the author is Windows-only. Being a web app running in a browser, it is expected to work, but there is no guarantee. Bug reports and pull requests for fixes are welcome)
- Motion generation in API key mode incurs OpenAI API usage fees (roughly a few yen to over a dozen yen per generation, varying depending on the model used and motion length).
- By enabling OpenAI's [Complimentary daily tokens data sharing program](https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai), you can **try it for free** within your daily free token quota
  (Note that API inputs and outputs are shared for OpenAI model training. Subject to eligible account and regional conditions. This program may be modified or terminated at OpenAI's discretion).
- Codex mode complies with usage limits and organizational policies of your logged-in ChatGPT/Codex plan.
  Users must verify whether using Codex subscriptions with this tool complies with OpenAI's terms of service and policies (use at your own risk).
- Logging out of Codex within the app affects the login state of the entire Codex CLI on this PC.
- **Even when using the ARDY local engine, setting an OpenAI API key (or compatible API) allows AI to handle complex action interpretation, splitting, and verification, making it easier to achieve motions closer to your intent**
  (It works via local translation even without an API key).
- The ARDY local engine is an experimental feature. Due to the nature of the model, different motions are generated on every run even with the same text (please regenerate if you aren't satisfied).
  Model weights (NVIDIA ARDY / Meta Llama 3 / FuguMT) are not included in this repository and must be downloaded by the user from their respective distributors (Hugging Face) during setup.
  Refer to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for each model's license.
- Use generated `.vrma` files at your own risk.

## Disclaimer

This software is provided "as is", without warranty of any kind.
The developer assumes no responsibility for any damages arising from the use or inability to use this software
(including API fees, data loss, troubles caused by generated products, etc.).
The use of generated `.vrma` files and various AIs/APIs is at your own risk.

## 💖 Support This Project

**Text-To-VRMA is a free, open-source project built by an independent developer.**

"Bring your character to life just by typing text" —
With that vision, including challenges like integrating NVIDIA's latest motion AI (ARDY), I plan to continue releasing convenient and easy-to-use open-source tools.

To be honest, I am currently between jobs and continuing development under financially difficult circumstances.
Yet, there is still so much I want to create. If this tool has been helpful to you, your support and encouragement would mean the world to me 🙇

---

**Text-To-VRMA is free & open-source, built by an independent developer in Japan.**

The goal: anyone can bring their VRM character to life just by typing —
powered by state-of-the-art motion AI, running on your own PC, free forever.

I'll be honest: I'm currently between jobs and building this through financially
difficult times. But there is so much more I want to create — more open-source
tools for the VRM / VTuber / creative community.

If this tool helps you, or you simply want to see more projects like it,
your support genuinely keeps this work (and its developer) going 💚

### **[❤️ GitHub Sponsors — github.com/sponsors/Kirakun0328](https://github.com/sponsors/Kirakun0328)**

Even a ⭐ on this repo means a lot!

## 🙏 Contributors

- [@emadurandal](https://github.com/emadurandal) — macOS support (macOS installer and startup stabilization for ARDY engine, [#2](https://github.com/Kirakun0328/text-to-vrma/pull/2)), and length specification bug report ([#5](https://github.com/Kirakun0328/text-to-vrma/issues/5)).
  Thank you for your fantastic contribution!
- [@taiyop](https://github.com/taiyop) — Added Electron desktop app build and startup instructions to README ([#3](https://github.com/Kirakun0328/text-to-vrma/pull/3)).
  Thank you!
- [@zzmzaizai](https://github.com/zzmzaizai) — Proposal for OpenAI-compatible provider support ([#4](https://github.com/Kirakun0328/text-to-vrma/issues/4)).
  Thank you!
- [@mouseos](https://github.com/mouseos) — Linux support (Linux installer and startup branching for ARDY engine, verified on real hardware, [#7](https://github.com/Kirakun0328/text-to-vrma/pull/7)).
  Thank you for your fantastic contribution!
- [@Misuta890](https://github.com/Misuta890) — Fixed engine switching bug in Electron version ([#8](https://github.com/Kirakun0328/text-to-vrma/pull/8)).
  Thank you!
- [@AUDOSt0ck1ng](https://github.com/AUDOSt0ck1ng) — Claude API (Anthropic) support (verified on browser and desktop versions, [#9](https://github.com/Kirakun0328/text-to-vrma/pull/9) / [#11](https://github.com/Kirakun0328/text-to-vrma/issues/11)).
  Thank you for your fantastic contribution!
- [@hsm-hx](https://github.com/hsm-hx) — Support for Claude 5.5 generation and Fable 5.1, server-side fallback on refusal ([#17](https://github.com/Kirakun0328/text-to-vrma/pull/17)).
  Thank you!
- [@meryuhi](https://github.com/meryuhi) — Fixed foot floating issue in ARDY engine retargeting (measured and verified ankle height in Unity, [#18](https://github.com/Kirakun0328/text-to-vrma/pull/18)).
  Thank you!

Bug reports, feature suggestions, and PRs are always welcome. Improving macOS / Linux environments relies heavily on community strength.

## Developer

- X (Twitter): [@Kiratchi0328](https://x.com/Kiratchi0328)

## License

- Source code: MIT License (Copyright (c) 2026 Kiratchi).
  **The MIT License applies only to the source code and excludes third-party materials (bundled VRM models, etc.)**
  (See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details).
- **Request regarding credit attribution**: When incorporating this tool into apps or services,
  while not mandatory, we would appreciate it if you could include attribution in your screen or credits section like the following:

  ```text
  Motion generation powered by Text-To-VRMA (© Kiratchi)
  https://github.com/Kirakun0328/text-to-vrma
  ```

  As a condition of the MIT License, copying and redistributing code requires including the above copyright notice and license text.

- Licenses for external models used by the ARDY local engine:
  - NVIDIA ARDY — Code: Apache-2.0 / Weights: NVIDIA Open Model Agreement (Commercial use permitted)
  - Meta Llama 3 — Meta Llama 3 Community License. This feature is **Built with Meta Llama 3**
  - FuguMT (Japanese-English Translation) — CC BY-SA 4.0
  - See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.
- The bundled AvatarSample model (© pixiv Inc.) is **excluded from the MIT License**.
  Pixiv Inc.'s [AvatarSample A-Z Terms of Use](https://vroid.pixiv.help/hc/ja/articles/4402394424089-AvatarSample-A-Z)
  applies (free use and redistribution permitted / **commercial redistribution and distribution as CC0 are prohibited**).
  Copyright and other rights regarding the model belong to their respective owners.
- Please follow the terms of use for any other VRM models.
- **Generated `.vrma` files are excluded from the MIT License** and belong to the user who generated them.
  This project makes no ownership claims over generated outputs, and they can be used freely, including for commercial purposes.
