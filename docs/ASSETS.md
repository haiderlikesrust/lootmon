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

## Square Lootmon logo

`public/brand/lootmon-logo-square.png` is a 1:1 social-profile version of the existing logo, generated with the built-in image tool on 2026-10-02. It uses a cobalt blue background and keeps the full wordmark inside a central crop-safe area. The original horizontal website logo is preserved.

Initial prompt:

> Use case: background-extraction/compositing. Asset type: finished 1:1 square social profile brand image. Edit the supplied Lootmon logo into a premium readable 1:1 square composition with an opaque suitable background. Preserve the exact logo: original LootMon lettering, exact spelling, playful chunky gold-yellow letters, blue outlines, red card emblem with its cream star, original proportions, highlights and edge shapes. Do not redesign or add letters. Place the complete supplied horizontal logo centered in the square, occupying about 82% of its width, with generous breathing room above and below and enough safe margin for a circular profile crop. Background: beautiful deep cobalt/navy blue, a subtle brighter royal-blue radial glow behind the logo, extremely faint soft diagonal game-card shapes near the far corners, a few tiny soft gold sparkles kept well away from the lettering. Clean game-brand avatar, confident simple bold colors; the existing logo is the hero. No extra text, no frame, no watermark, no characters, no UI mockup. Crisp high-resolution square image, 1:1 aspect ratio.

Final refinement prompt:

> Refine this square Lootmon brand image. Preserve the exact existing artwork, colors, logo spelling, lettering, red card-star emblem, and blue glow background. Only change the size of the complete central logo group: reduce it so the full red emblem plus LootMon wordmark occupies approximately 78 percent of the square canvas width, leaving around 11 percent empty blue background at each side. Keep the logo precisely centered both horizontally and vertically. This is for a circular social profile crop inside the square, so all letters and the red emblem must comfortably fit inside the central safe circle. Keep the original 1:1 square canvas and the same tasteful dark cobalt blue background, corner card silhouettes and small sparkles. No added words, no border, no new icons.

## X profile banner

`public/brand/lootmon-x-banner.png` is the matching 3:1 header (2172 × 724), generated with the built-in image tool on 2026-10-02 using the existing logo and Looter portrait as references. The lower-left area is kept free of essential branding for the overlapping profile picture.

Generation prompt:

> Create a finished Lootmon X/Twitter profile HEADER BANNER with EXACT 3:1 aspect ratio, a very wide horizontal canvas 3072 pixels wide by 1024 pixels high. Reference image 1 is the established horizontal LootMon logo: preserve its exact lettering, spelling, gold/yellow, cobalt blue outline and red star-card emblem. Reference image 2 is Looter, our friendly gold robot mascot: preserve its blue faceplate, glowing square eyes, red scarf and card-shaped forehead crest. This is an original polished game-brand social banner matching a deep cobalt-blue Lootmon profile picture. Compose a cinematic wide game-adventure scene: a richly luminous cobalt/navy blue backdrop with subtle depth, a stylized low-poly floating island town along the bottom right with warm cream houses, orange roofs and green trees, a small number of collectible gold/blue treasure-card packs drifting at the far sides. Keep the complete LootMon logo proudly readable near the center, slightly right of the canvas center, occupying about 45 percent of total width, vertically around the upper-middle. Friendly Looter appears as a three-quarter chest-up robot portrait near the right edge, smaller than the logo, peeking from the island. Sophisticated fun 3D game art, soft studio-like highlights, bright golden sparkle accents sparingly. Bottom-left quarter must remain quiet dark-blue scenery with no important text or mascot because an X profile avatar overlaps there. All important content stays away from top and bottom edges and has comfortable safe margins for mobile crops. Seamlessly cohesive visual style, palette gold-yellow/cobalt-blue/warm ivory with red accents. No additional words or slogans, no interface, no X logo, no watermark, no border. Wide horizontal 3:1 format is essential.

## Looter chat portrait

`public/art/looter-avatar.png` is an original mascot portrait generated with the built-in image-generation tool on 2026-10-02 for Lootmon. Its gold shell, blue faceplate, red scarf and card crest match the game's branding. The chat UI uses it only for server-authored Looter messages; players cannot assign themselves the bot badge or portrait.

Generation prompt:

> Use case: stylized-concept. Asset type: square profile portrait for Looter, the friendly chat bot in Lootmon, a colorful online card treasure-hunting game. Create a polished original game mascot portrait, a small chunky treasure-chest robot explorer with a cobalt-blue faceplate, two expressive glowing cream-yellow square eyes, gold/yellow armored shell, a red neckerchief, and a tiny card-shaped crest. Friendly mischievous expression and confident head tilt. Blocky low-poly 3D / voxel-inspired game character styling, appealing soft sculpted bevels, crisp readable silhouette, high quality rendered collectible game art. Head and shoulders only, centered and tightly composed so it reads clearly at 32px chat avatar size. Background is a simple deep navy-to-royal-blue circular aura with a few subtle golden sparkles, fills the square. Strong bright gold, cobalt blue, warm ivory, red accent palette matches Lootmon branding. Clean studio rim light, charming game UI mascot, no weapons, no text, no letters, no watermark, no border. One character only. Square 1024x1024 image.
