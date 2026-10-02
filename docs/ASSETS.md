# Character assets

The player and other collectors use modeled, textured, skinned humanoid characters from **KayKit — Adventurers Character Pack 1.0**, created by **Kay Lousberg**. The official repository declares the pack **CC0 1.0 Universal**, permitting commercial use, modification, and redistribution without required attribution.

- Official source: https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0
- Creator: https://kaylousberg.com/
- Pack page: https://kaylousberg.itch.io/kaykit-adventurers
- Pinned source revision: `672074b73ba276876a19e8816ecdc5241817ab47`
- Downloaded: 2026-10-02.
- Original license: `public/models/kaykit-adventurers/LICENSE.txt`.
- Exact output hashes, clips, and removed meshes: `public/models/kaykit-adventurers/manifest.json`.

| Local URL | Role | File size |
| --- | --- | --- |
| `/models/kaykit-adventurers/Rogue.glb` | Unhooded collector/explorer | 743,664 bytes |
| `/models/kaykit-adventurers/Rogue_Hooded.glb` | Hooded explorer variant | 725,236 bytes |
| `/models/kaykit-adventurers/Mage.glb` | Optional robed adventurer variant | 749,360 bytes |

These are self-contained GLB files with embedded PNG atlas textures and embedded skeletal animation. No CDN, external texture request, paid content, or runtime asset service is needed.

## Preparation

The source models included weapon/accessory meshes and 76 animation clips. The shipped derivatives remove knives, crossbows, throwable objects, spellbooks, wands, and staves. Capes and the mage's hat remain. Unused meshes, animation accessors, and binary buffer views were pruned and repacked; textures and the character rig are preserved. This reduces the three-model download from roughly 10.8 MB to 2.2 MB. The models are unarmed.

Each model contains these exact clips:

| Clip | Duration | Suggested use |
| --- | ---: | --- |
| `Idle` | 1.067 s | Standing loop |
| `Walking_A` | 1.067 s | Normal movement loop |
| `Running_A` | 0.800 s | Sprint loop |
| `Running_B` | 1.067 s | Alternate movement loop |
| `PickUp` | 1.300 s | Taking a pack |
| `Interact` | 1.300 s | Inspecting a hiding place |
| `Cheer` | 1.667 s | Successful delivery |
| `Jump_Start` | 0.600 s | Takeoff |
| `Jump_Idle` | 1.067 s | Airborne loop |
| `Jump_Land` | 0.667 s | Landing |
| `Hit_A` | 0.667 s | Theft/stagger response |
| `Dodge_Forward` | 0.400 s | Optional dodge |

## Loader notes

- Coordinate convention: **+Y up, +Z forward**. The cape lies behind the character on -Z. Rotate the wrapper toward the movement vector with `atan2(direction.x, direction.z)`.
- Scene root and skin name: **`Rig`**. Each character has 41 joints. Useful bone names include `root`, `hips`, `spine`, `chest`, `head`, `hand.l`, `hand.r`, `handslot.l`, and `handslot.r`.
- Three.js sanitizes periods in animation binding node names; use the loaded bone's actual `.name` when attaching an object. The GLB source names above are preserved in the manifest/rig data.
- Source bind-pose body height is approximately **2.187 units** for Rogue and **2.251 units** for Rogue_Hooded; feet are at y≈0. Scale their wrapper to the game's chosen player height (for 1.9 units, approximately 0.869 and 0.844). Mage's hat extends above its body, so normalize using the desired body size rather than its hat-inclusive bounds.
- Use `SkeletonUtils.clone()` when instancing a cached GLTF scene. A plain `.clone()` does not independently bind each collector's skeleton.
- Give each cloned actor its own `AnimationMixer`; cross-fade idle/walk/run actions. Move the actor's outer world-position wrapper; animate the imported model beneath it.
- Keep the atlas texture in sRGB and retain the supplied skin/material assignments. Character geometry should cast and receive the map's shadows.

The source and compacted outputs were inspected structurally for embedded textures, skins, clip names, and buffer references. Rendering and movement are verified in the game's character integration.
