# ANOMALY DETECTOR — audio-reactive 3D visualizer

A faithful reconstruction of **[“[gsap/threejs/inertia] ❍ Audio Visualizer with THREEJS”](https://codepen.io/filipz/pen/yyyRgry)**
by **Filip Zrnzevic (filipz)** — his entry for the Webflow × GSAP Community
Challenge #2 (*Draggable & Inertia*), which he documented in the Codrops
tutorial [“Coding a 3D Audio Visualizer with Three.js, GSAP & Web Audio API”](https://tympanus.net/codrops/2025/06/18/coding-a-3d-audio-visualizer-with-three-js-gsap-web-audio-api/)
(June 2025) — **extended with a MORPHOLOGY system that lets the anomaly take
8 different shapes.**

This is an original implementation of the same feature set (the CodePen
source is bot-protected, so the demo and the author’s own tutorial were used
as the spec). All credit for the concept and design goes to Filip Zrnzevic.

## Run it

No build, no network needed:

```bash
# easiest — single self-contained file (everything inlined):
open visualizer/standalone.html     # double-clicking works too (file://)

# or the split sources:
open visualizer/index.html          # loads app.js + vendor/ relatively

# or serve the folder
python3 -m http.server -d visualizer 8000   # → http://localhost:8000
```

> The MIC source requires a secure context (https or localhost).

---

## Features extracted from the original

### Visual

| Feature | Original | This reconstruction |
| --- | --- | --- |
| Concept | Sci-fi “anomaly detector” reacting to music | Same |
| The anomaly | Glowing orange-to-white orb in a dark void | Same palette (`#ff6a14 → #ffe7cf`) |
| Outer lattice | Wireframe `IcosahedronGeometry` + custom `ShaderMaterial`, vertices displaced by simplex noise × audio | Same (additive-blended glowing wireframe, noise displacement in the vertex shader) |
| Inner glow | Semi-transparent emissive shader sphere forming a halo/aura | Fresnel core shader + additive back-side halo shell |
| Atmosphere | Dark void, dust/bokeh depth | 850-point twinkling particle field, radial void gradient |
| HUD styling | Terminal-style micro-type, uppercase, letter-spaced, corner labels | Same: 4 corner info blocks, monospace stack, orange accent |
| Panels | Floating dark glass control panels with corner notches | Same: blurred glass, 1px borders, corner brackets, top accent line |
| FX layers | CRT mood | Scanlines, vignette, animated film grain, rotating calibration reticle + crosshair |
| Beat feedback | Orb pulses/spikes to the beat | Beat-synced GSAP pulse tweens: orb pop, reticle flash, panel border flash |

### Layout

- Fullscreen Three.js stage, orb centered, camera with slow orbital sway.
- Four fixed corner HUD blocks: title/unit (TL), credits/original link (TR),
  live status log (BL), input hints (BR).
- Four floating panels around the stage: **SIGNAL** (transport),
  **PARAMETERS** (sliders), **TELEMETRY** (spectrum + scope + meters), and
  **MORPHOLOGY** (new). All draggable anywhere, bounded to the viewport.

### Functionality

| Feature | Notes |
| --- | --- |
| Web Audio analysis | `AnalyserNode` (FFT 2048) tapped **pre-compressor**; bass/mid/treble bands + overall level, fast-attack/slow-release smoothing |
| Audio → shader mapping | Bands drive displacement amplitude, scale pulse, wireframe “heat” color, halo alpha, particle speed/brightness |
| Beat detection | Dedicated band-passed (≈58Hz) analyser → time-domain RMS spike vs rolling mean; median-based BPM readout; fires event-based GSAP tweens layered over per-frame shader animation (as in the original tutorial) |
| Draggable panels with momentum | `Draggable.create` + `InertiaPlugin` (`inertia: true`, `edgeResistance`, viewport bounds, z-raise on grab) |
| Grab & fling the orb | Ray-sphere hit test → pointer drag rotates the orb; on release a `gsap.to(..., { inertia })` throw continues rotation with tracked angular velocity (clamped pitch) |
| Control sliders | The original’s set — **ROTATION** (0–5), **RESOLUTION** (live retessellation from ~60 to ~37k vertices, vertex-count readout), **DISTORTION** (0–6), **REACTIVITY** (0–6), **SENSITIVITY** (0.1–5) — plus **FRACTURE** (0–2), VOLUME (0–150%) and ECHO |
| Transport | Play/pause (button morphs ▶/⏸), elapsed time, track label, status line |
| Audio sources | **DEMO** — seven built-in procedural tracks (below), fully offline; **FILE** — picker or drag-&-drop, decoded locally; **MIC** — analysis-only routing (no feedback). The original streamed an mp3; the synth engine keeps this copy self-contained |
| Demo tracks | Pattern-sequencer synth engine (`◂`/`▸` in SIGNAL, or `T`): **TECHNO PULSE** 126 · **SYNTHWAVE RUN** 100 (arpeggios, gated snare) · **BREAKBEAT FLUX** 172 (DnB breaks, sub bass) · **LOFI BOOM BAP** 88 (swing, e-piano, vinyl bed) · **JAZZ NOIR** 120 (swung ride, walking bass) · **AMBIENT DRIFT** 64 (pads, bells, swells) · **CARDIAC LUB-DUB** — a synthesized two-tone heartbeat (S1 "lub" / S2 "dub") with `−`/`+` heart-rate controls, 40–200 BPM |
| Keyboard | `SPACE` play/pause · `T` next track · `1–9`/`0` select shape · `←`/`→` cycle shapes · `C` next colour scheme · `F` focus mode · `R` random shape |
| Misc | Status log rotation, LEVEL/PEAK dB/PULSE BPM meters, DPR-capped resize, WebGL failure overlay |

### Added in this version (beyond the original)

**MORPHOLOGY — 16 shapes.** The original anomaly is an icosahedron only.
The MORPHOLOGY panel (keys `1–9`/`0`, `←`/`→` to cycle, `R` random) reshapes
the lattice while keeping the full audio-reactive treatment:

| # | Form | Geometry | # | Form | Geometry |
| --- | --- | --- | --- | --- | --- |
| 1 | ICOSAHEDRON | `IcosahedronGeometry` | 9 | TETRAHEDRON | `TetrahedronGeometry` |
| 2 | SPHERE | `SphereGeometry` | 10 | PYRAMID | `ConeGeometry` (4 sides) |
| 3 | TORUS | `TorusGeometry` | 11 | CONE | `ConeGeometry` |
| 4 | TORUS KNOT | `TorusKnotGeometry` | 12 | CYLINDER | `CylinderGeometry` |
| 5 | OCTAHEDRON | `OctahedronGeometry` | 13 | GEMSTONE | stretched `OctahedronGeometry` |
| 6 | DODECAHEDRON | `DodecahedronGeometry` | 14 | HALO RING | thin `TorusGeometry` |
| 7 | PRISM CUBE | `BoxGeometry` (segmented) | 15 | HELIX COIL | `TubeGeometry` on a custom helix curve |
| 8 | CAPSULE | `CapsuleGeometry` | 16 | STELLATED | `ExtrudeGeometry` 5-point star |

Switching plays a GSAP morph (back-ease implosion → geometry swap → elastic
overshoot + pulse flash), and the RESOLUTION slider retessellates whichever
form is active.

**FRACTURE — way more breaks.** Every geometry is converted to non-indexed
triangles with per-face centroid/seed attributes; a quantized per-face noise
field moves whole triangles rigidly so the shell visibly tears, shards burst
outward from the centre, and beats kick the fragments apart. The glowing core
keeps a low fracture value so light leaks through the cracks. Controlled by
the new FRACTURE slider; DISTORTION and REACTIVITY ranges were raised too.

**CHROMA — 10 colour schemes.** EMBER, CRYO, VIRIDIAN, ULTRAVIOLET, CRIMSON,
SOLAR, NEON ROSE, ABYSS AQUA, GHOST, ACID. Pick a swatch (PARAMETERS panel)
or hit `C` to step through; CYCLE auto-rotates every 8s. Shader colours tween
via GSAP and the whole HUD (accents, sliders, VU, spectrum, scope) follows
through CSS variables.

**FOCUS mode.** Every panel header has a fold button (`—`/`+`) for a
vertical fold. The ◈ FOCUS button (or `F`) squashes ALL four panels in sync —
first vertically, then horizontally — into small square chips (status dot +
`+`), dims the corner HUD and dollies the camera in so the anomaly fills the
screen. Click any chip to restore that panel; FOCUS again restores all.

**More signal/telemetry bells & whistles.** SIGNAL gains an ECHO send
(feedback-delay wet control) and a 16-segment VU LED strip; TELEMETRY gains
BASS/MID/TREB band meters and BEATS/FPS/FORM readout cells.

**The TR corner** now carries a small ode to music, poetry and the pursuit of
harmony (attribution moved to the TL corner).

## Files

```
visualizer/
├── standalone.html      single-file bundle — just open it, nothing else needed
├── index.html           markup + all styling (HUD, panels, CRT overlays)
├── app.js               scene, shaders, shapes, audio engine, interactions
├── vendor/              three.js r149 · gsap 3.13 + Draggable + InertiaPlugin
└── build_standalone.py  regenerates standalone.html from the sources above
```

`standalone.html` is generated — edit `index.html`/`app.js` and rerun
`python3 build_standalone.py` to rebuild it.
