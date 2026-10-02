# KairoForge Holo overlay

This folder stores the KairoForge upgrades for the local Holo Gestures checkout.

The live app on this computer is at:

```bash
/Users/franksmith/holo
```

`kairoforge-holo-hands.patch` is everything on top of upstream `main`:

- **Embed mode** (`?embed=kairoforge&parent=<origin>`). KairoForge's Personal AI plugin opens
  the deck full screen when you say "open holo hands". The KairoForge parent owns the scene
  (items + connectors) and sends it by origin-checked `postMessage`; the deck reports hand,
  face, and body signals back as derived numbers only.
- **Items**: note, text, 3D shape, 3D model, image, web page, sandboxed widget, action, and
  sensor. **Connectors** carry values from one item to the next.
- **On-device tracking**: MediaPipe hands, face (blendshapes + head direction), and pose.
- **No shell control**: the old `KF_ARMED` / `run <command>` / `/api/exec` path is removed.
  Anything that changes the computer goes through KairoForge approvals.
- The older KairoForge Call panel, holographic keyboard, and standalone helpers.

To apply it to a fresh Holo checkout:

```bash
cd ~/holo
git apply /Users/franksmith/Documents/KalroForge/packages/local/holo-gestures/overlays/kairoforge-holo-hands.patch
cd vendor
curl -fsSLO https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
curl -fsSLO https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task
```

The model files are not in the patch. Without them the deck falls back to Google's hosted
copies. KairoForge starts `python3 server.py` itself when you open Holo Hands.
