# KairoForge Holo overlay

This folder stores the KairoForge upgrades for the local Holo Gestures checkout.

The live app on this computer is at:

```bash
/Users/franksmith/holo
```

The overlay patch in this folder adds the KairoForge Call panel, voice/text command bridge,
movable holographic keyboard, hang-up control, 3D item commands, and the updated README notes.

To apply it to a fresh Holo checkout:

```bash
cd ~/holo
git apply /Users/franksmith/Documents/KalroForge/packages/local/holo-gestures/overlays/kairoforge-call-overlay.patch
python3 server.py
```
