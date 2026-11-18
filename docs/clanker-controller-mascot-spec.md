# Clanker Controller Mascot: Brand, Architecture & Motion Handoff

Document version: `1.0.0`  
Status: **Approved for Production & Animation Ready**  
Owner: `ai-chat-panel` / Design & Architecture  
Associated Repositories:
- Workspace Master: [`Clanker_Controller_logo.svg`](file:///C:/Users/user/Nextcloud/Eigene%20Projekte/Portfolio/2026/Clanker_Controller_logo.svg)
- Extension Media: [`astro-visual-editor/tools/ai-chat-panel/media/clanker.svg`](file:///C:/Users/user/Nextcloud/Eigene%20Projekte/Portfolio/2026/astro-visual-editor/tools/ai-chat-panel/media/clanker.svg), [`clanker-dark.svg`](file:///C:/Users/user/Nextcloud/Eigene%20Projekte/Portfolio/2026/astro-visual-editor/tools/ai-chat-panel/media/clanker-dark.svg)

---

## 1. Executive Summary & Character Identity

**Clanker Controller** is the brand mascot and application icon for the AI Chat Panel and editor tools in the Antigravity / VS Code environment. 

### Visual Identity & Philosophy
* **Core Metaphor:** A sentient, autonomous game controller companion. The controller faceplate *is* the robot's face.
* **Aesthetic Direction:** Swiss graphic minimalism meets Teenage Engineering hardware design. Flat 2D monochrome vector glyph.
* **Facial Anatomy:**
  - **Chassis:** Solid white chunky game controller silhouette with rounded ergonomic grips.
  - **Screen Visor:** Inset horizontal black rounded-pill OLED screen.
  - **Eyes:** Stepped 8-bit digital pixel-matrix clusters (sharp polygon corners, not soft rounded circles).
  - **Attitude / Eyebrows:** Highly asymmetrical personality. The right eyebrow is cocked high in a curious, inquisitive arch; the left eyebrow sits lower and level.
  - **Zero Noise:** Strictly no mouth, no nose, no physical controller buttons (no A/B/X/Y or D-pad clutter), no decorative lines.
* **Anatomy Boundary (Critical):** Clanker is a **disembodied, self-contained floating object**. He has **no torso, no neck, no shoulders, and no limbs**.

### Empty-state rendering (Liquid Glass 2.0)
The flat monochrome rules above describe the icon assets. The empty-state rig in the chat (`media/clanker-mascot.js`) draws the same silhouette as glass, still 2D: no drop shadow, no bevel, no gloss blob.
* **Body glass:** a slate-tinted frosted fill (a mid tone, so it holds on both dark and light IDE themes), a lit rim top left with a faint echo bottom right, a soft glow just inside the edge, and a hairline outline.
* **Screen glass:** the visor stays dark in every theme, recessed, with one quiet diagonal reflection. Eyes and brows are pure white and are never tinted.
* **Tokens:** `--cg-*` on `.empty-mark .clanker-rig` in `style.css`; `vscode-light` retunes them, and high contrast gets an opaque body with a hard outline.

---

## 2. Technical Asset Catalog & Contracts

| File | Repo Location | Purpose | Theme / Behavior |
| :--- | :--- | :--- | :--- |
| [`Clanker_Controller_logo.svg`](file:///C:/Users/user/Nextcloud/Eigene%20Projekte/Portfolio/2026/Clanker_Controller_logo.svg) | Root (`.`) | Master Brand Asset | `fill="currentColor"`, stripped Adobe metadata (880 B). |
| [`clanker.svg`](file:///C:/Users/user/Nextcloud/Eigene%20Projekte/Portfolio/2026/astro-visual-editor/tools/ai-chat-panel/media/clanker.svg) | `astro-visual-editor` | Activity Bar & Light Theme Tabs | `fill="currentColor"` with `style="color: #1e1e1e;"` fallback. |
| [`clanker-dark.svg`](file:///C:/Users/user/Nextcloud/Eigene%20Projekte/Portfolio/2026/astro-visual-editor/tools/ai-chat-panel/media/clanker-dark.svg) | `astro-visual-editor` | Dark Theme Tabs & Sidebars | `fill="currentColor"` with `style="color: #C5C5C5;"` fallback. |

### Stencil Geometry & ViewBox Specifications
* **ViewBox:** `0 0 374.78 296.77`
* **Path Topology:** The controller chassis is an `evenodd` compound path:
  - Subpath 1 (`M294.4...`): Outer perimeter of the controller body.
  - Subpath 2 (`ZM289.89...`): Inner perimeter cutout forming the transparent visor window.
* **Polarity Invariance:** Because the visor is a true negative-space cutout hole, rendering in `fill="currentColor"` against dark themes makes the chassis and floating eyes white while the visor inherits the dark UI background. Against light themes, the reverse occurs naturally.

```xml
<svg id="clanker-controller" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 374.78 296.77" width="100%" height="100%" fill="currentColor">
  <!-- 1. Controller Chassis & Visor Cutout (Compound Path) -->
  <path fill-rule="evenodd" d="M294.4,258.9l-14.83-21.98..."/>
  
  <!-- 2. Right Eye Pixel Cluster -->
  <polygon points="247.93 135.7 225.69 135.73 225.67 129.79 219.72 129.76 219.72 124.52 214.18 124.48 214.15 118.35 208.41 118.3 208.41 96.74 214.06 96.71 214.2 90.39 219.74 90.31 219.83 85.05 225.68 85 225.74 78.95 247.94 78.93 248.02 85 253.78 85.01 253.81 90.22 259.49 90.31 259.6 96.44 265.38 96.51 265.33 118.13 259.57 118.11 259.56 124.17 253.91 124.16 253.83 129.61 247.98 129.62 247.93 135.7"/>
  
  <!-- 3. Left Eye Pixel Cluster -->
  <polygon points="140.48 135.21 123.78 135.19 123.74 129.86 118.16 129.8 118.09 124.55 112.89 124.49 112.89 107.23 118.15 107.24 118.17 101.79 123.68 101.78 123.72 96.4 140.53 96.38 140.54 101.84 145.8 101.84 145.79 107.23 151.12 107.28 151.12 124.56 145.93 124.58 145.82 129.8 140.49 129.82 140.48 135.21"/>
  
  <!-- 4. Right Eyebrow (Inquisitive Arch) -->
  <polygon points="272.16 74.13 255.05 57.3 216.17 60.18 215.11 49.48 258.94 46.27 279.64 66.68 272.16 74.13"/>
  
  <!-- 5. Left Eyebrow (Level) -->
  <polygon points="111.71 85.86 98.81 98.59 91.08 91.02 106.88 75.42 152.6 75.43 152.62 85.86 111.71 85.86"/>
</svg>
```

---

## 3. Rigging & Animation Coordinate Contract

For CSS animations (Codex / webviews) or After Effects rigging, adhere to these geometric coordinates:

```
ViewBox: [0, 0, 374.78, 296.77]
Visor Safe Center: [187.4, 115.0]
Max Safe Translation Limits: X ∈ [-12px, +12px], Y ∈ [-8px, +8px]

Element Map:
├── #controller-chassis
│   └── Center: [187.4px, 148.4px] -> Subtle hover bob / breathing scale (100% <-> 101.5%)
├── #eye-left
│   └── Bounding Center: [132.0px, 115.8px] -> scaleY (blink), translate(dx, dy)
├── #eye-right
│   └── Bounding Center: [236.9px, 107.3px] -> scaleY (blink/wink), translate(dx, dy)
├── #brow-left
│   └── Center: [121.8px, 87.0px] -> translateY(0 to -3px)
└── #brow-right
    └── Hinge Pivot Point: [245.0px, 60.0px] (Bottom-left corner)
        └── rotate(-4deg to +8deg), translateY(0 to -5px)
```

---

## 4. Acoustic Identity (Voice & Audio)

* **Classification:** **Astromech Droid / Analog Modular Synthesizer (R2-D2 / BD-1 Class)**.
* **Strict Rule:** **Zero human speech, zero spoken words.**
* **Acoustic Characteristics:**
  - High-frequency pitch-bent sine and triangle waves ($600\,\text{Hz} \leftrightarrow 2400\,\text{Hz}$).
  - Melodic two-tone chirps and trills for curiosity.
  - Ascending frequency glides for task success / affirmative states.
  - Low descending electronic warble for warnings / syntax errors.
* **Implementation Options (Zero Cost):**
  1. *Web Audio API (Webviews/Browser):* Procedural 10-line oscillator pitch-glide (0 KB payload).
  2. *BFXR / SFXR:* Procedural retro synthesizer export to `.wav`.
  3. *Flow Video Audio Prompting:* `"Audio: Authentic R2-D2 style astromech droid noises, electronic whistling, frequency-modulated beeps, zero human speech."`

---

## 5. Research Findings & Tooling Retrospective

### What Failed
1. **Google Flow "Character" Tool:**
   - *Failure Mode:* The Character tool is biased toward humanoid cinematic storytelling. It forced a mecha humanoid torso, neck, and shoulder pads onto the controller because it treated the controller as a "helmet/head".
   - *Style Drift:* Nano Banana Pro in the Character tool repeatedly defaulted to 3D product photography (Xbox ABXY buttons, plastic seams, studio lighting, jet thruster engine pods).
   - *TTS Engine:* Built for spoken dialogue; onomatopoeia was pronounced phonetically like a human reading a script.

### What Succeeded
1. **Direct Image Trace (Adobe Illustrator):**
   - High path fidelity (75% paths, 50% corners, 2-5px noise filter) accurately preserved the pixel eye clusters without rounding them into ellipses.
2. **Image-to-Video (I2V) with Omni:**
   - Locking the master 1:1 image as the input reference eliminates 3D drift. The prompt only dictates the animation delta.
3. **Pipeline B (AI-Engineered Pure SVG / CSS):**
   - Inlining `@keyframes` directly into the SVG file creates an ultra-lightweight, zero-runtime asset that functions everywhere an `<img>` tag or webview exists.

---

## 6. Handoff & Next Steps

### Repository ownership

The old nested-repository staging instructions no longer apply. Clanker Controller owns this document, `ai-chat-panel/media/` and the master logo at `assets/Clanker_Controller_logo.svg`. Follow the root [agent instructions](../AGENTS.md) for Git operations and [backlog](../TODO.md) for selected work. Animation ideas below are reference material, not an outstanding commit task.

### Resuming Animation Work
When returning to implement motion:
1. **For Web / IDE Webviews:** Use the Codex prompt in Section 3 of Pipeline B to inject CSS keyframes into `Clanker_Controller_logo.svg` to output `clanker-animated.svg`.
2. **For Video / Motion Assets:** Use Image-to-Video in Flow with Omni using the 1:1 JPG reference and the prompts from Section 3 of this document.
