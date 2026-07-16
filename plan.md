# HEATLINE: SOLARA — Ground-Truth Implementation Plan

Last updated: 2026-07-16 18:14 CEST
Plan status: Active  
Current focus: M5 implementation
Canonical project path: `/Users/logge/Documents/GTA-Web`  
Staging path while sandboxed: `/Users/logge/Documents/Codex/2026-07-16/grilling-users-logge-codex-skills-grilling/GTA-Web`

## How this plan is used

This file is the source of truth for implementation scope, behavior, acceptance, and progress. It supersedes informal earlier chat unless the user explicitly changes a requirement. Every milestone is marked `PENDING`, `IN PROGRESS`, `BLOCKED`, or `COMPLETE`. A milestone becomes `COMPLETE` only after its acceptance checks pass. Update the current focus and progress log whenever work advances; do not keep a competing hidden checklist.

One feasibility correction is locked in: the game will use stylized, non-graphic violence rather than always-on extreme gore. GitHub Pages restricts gratuitously graphic violent content, while publishing to GitHub Pages is a hard delivery requirement. There will be no dismemberment, executions, persistent wounds, or gore simulation. Combat may use brief abstract impact flashes, ragdolls, and non-graphic defeat animations.

## Product definition

**Title:** *HEATLINE: SOLARA*  
**Format:** Original single-player, third-person, open-world crime-action RPG for modern desktop and mobile browsers. It is genre-inspired but must not use names, logos, characters, map layouts, dialogue, music, UI, missions, or assets from Grand Theft Auto or any other commercial game.  
**Audience and tone:** Mature crime drama with satire, strong language in text, and criminal themes; visual violence remains non-graphic for hosting compatibility.  
**Target experience:** 6–8 hours for the 12 authored missions and 10–15 hours with activities, properties, exploration, and progression.  
**Devices:** Keyboard/mouse desktop and landscape touch mobile. No gamepad requirement in v1.  
**Performance:** 60 FPS target on a current desktop and stable 30 FPS on a representative mid-range phone, with adaptive density and resolution. Initial compressed application shell under 20 MB. Published site under GitHub Pages' 1 GB limit.

### Player fantasy and success criteria

The player is Alex Moreno, a debt-burdened mechanic and former street racer trying to preserve the family garage while three underworld contacts uncover a citywide creditor/property conspiracy. The finished game must let a new player:

1. Start from a splash/menu, choose one of three local save slots, and select masculine or feminine Alex presentation.
2. Explore a continuous-feeling four-district city on foot or in any road vehicle.
3. Complete a tutorial, pursue three mission-giver chains in flexible order, complete a convergence mission, and choose one of two endings.
4. Fight, sneak, drive, evade a five-level police response, level to 20, buy skills and attributes, manage a tactical inventory, craft utilities, buy properties, and complete repeatable activities.
5. Resume reliably from an autosave, export/import saves, use accessible settings, and play with either desktop or landscape touch controls.
6. Load and run from the deployed GitHub Pages URL without a backend, broken asset paths, console errors, or repository-specific manual configuration.

## Locked design

### City and presentation

- **Solara** is a fictional bright coastal city rendered in a colorful stylized low-poly aesthetic.
- Four authored districts are connected by lighter procedural streets: **Neon Strand** (beach/nightlife), **Alta Vista** (downtown/civic towers), **Arroyo Heights** (hills/residential/garage), and **Breakwater** (port/industrial).
- Approximate playable footprint is 1.5 km². The runtime divides it into deterministic 256 m cells and streams the current cell plus its neighbors. Mission interiors load as small separate scenes behind short door/elevator transitions.
- Key interiors only: Moreno Garage, three contact hubs, five properties, weapon dealer, clinic, selected mission interiors, and the finale tower.
- A 24-minute day/evening/night cycle changes light colors and emissive windows. Lightweight rain can begin during authored weather windows; it alters ambience and road grip slightly but does not simulate puddles or flooding.
- Adaptive city life uses pooled traffic and pedestrians. High quality targets roughly 24 active vehicles and 45 pedestrians; low quality targets 10 vehicles and 18 pedestrians. Distant actors become cheap impostor logic or despawn outside mission relevance.

### Protagonist, contacts, and campaign structure

- **Alex Moreno:** fixed history and personality with two body/voice-presentation presets. Dialogue is written without gendered references; there is no full character creator and no recorded voice acting.
- **Juno Vale:** street racer and smuggler; driving, vehicle theft, convoy, and pursuit missions.
- **Malik Rook:** nightclub fixer; brawls, firefights, robberies, protection, and social infiltration.
- **Priya Shah:** investigative hacker; stealth, traversal, signal puzzles, surveillance, and conspiracy missions.
- Dialogue appears through short in-engine conversations, subtitles, phone/radio panels, and text bleeps. All required story information remains skippable and reviewable in a mission log.
- Mission 1 unlocks the first job from all three contacts. Each contact's missions are internally ordered, but chains can be interleaved. Contact reputation gates the second and third jobs. Completing all nine contact jobs unlocks mission 11; mission 11 unlocks the finale. No story mission becomes permanently missable.

### Twelve authored missions

1. **Past Due — Prologue:** Debt collectors raid Moreno Garage and steal a customer car on a tow truck. Tutorialize movement, brawling, driving, pursuit, interaction, inventory, and checkpoint recovery while Alex retrieves it.
2. **Coastline Burn — Juno I:** A street race crosses Neon Strand; rival sabotage closes the obvious route and teaches shortcuts, vehicle damage, handbrake turns, and repair kits.
3. **Rolling Stock — Juno II:** Alex intercepts a moving luxury-car transporter, transfers into the target vehicle, and loses a two-level police pursuit before delivering it intact.
4. **Bridge Run — Juno III:** Escort a three-vehicle smuggling convoy through Breakwater while roadblocks and a timed drawbridge force route and protection choices.
5. **Last Call — Malik I:** Defend Malik's nightclub through a brawl, a close-quarters firefight, civilian evacuation, and a getaway through rain-slick streets.
6. **Glass House — Malik II:** Enter an Alta Vista developer gala in disguise, plant a listening device with optional stealth, and escape down a maintenance route when cover is blown.
7. **Container Zero — Malik III:** A port exchange becomes an ambush; use a crane-control puzzle to reposition containers, fight through the yard, and extract Malik in a damaged pickup.
8. **Dead Air — Priya I:** Traverse a broadcast tower, disable three jammer relays, and hold the rooftop while hostile climbers approach from multiple access points.
9. **Night Train — Priya II:** Chase a metro maintenance train from a parallel road, board its slow rear service car at an authored transfer point, copy a ledger, and disembark before the tunnel.
10. **Black Grid — Priya III:** Trigger a controlled Alta Vista blackout, infiltrate a data center under emergency lighting, and escape while tactical police mistake Alex for the saboteur.
11. **Full Account — Convergence:** All contacts meet at the garage to decode the ledger. Defend the garage, escort a mobile transmitter across three districts, and expose the creditor syndicate's command tower.
12. **Freehold — Branching Finale:** Infiltrate the tower and reach the rooftop uplink during a level-five response. Choose **Rule** to seize the network and reroute its funds, or **Expose** to broadcast the ledger and destroy the network. Both branches share locations but use distinct objectives, dialogue, epilogues, and postgame modifiers.

**Ending state:** Rule gives +20% property income and cheaper black-market goods but increases police heat gain by 10%. Expose reduces wanted-search duration by 20% and increases legitimate property perks but raises black-market prices by 10%. Free roam, incomplete activities, collectibles, and saves remain available after either ending.

### Core movement, camera, and controls

- On foot: walk, sprint, jump, crouch, low vault, ladder climb, contextual ledge mantle, soft cover, shoulder swap, and water reset to the nearest shore point. No swimming, diving, broad parkour, or free climbing.
- Camera: orbiting third-person follow camera, tighter over-shoulder aim view, obstacle avoidance, and speed-responsive vehicle chase camera. Camera shake and motion can be reduced independently.
- Desktop default bindings: WASD move/drive; mouse camera/aim; left click fire/light attack; right click aim; Shift sprint; Space jump/handbrake; C crouch/camera; E interact/enter/exit; F melee/context finisher; R reload/vehicle reset; Q shoulder swap; Tab weapon radial; I inventory; M map; Esc pause. Keyboard bindings are remappable.
- Mobile landscape: left virtual stick, right-side camera drag, contextual action/enter/fire/aim buttons, distinct on-foot and vehicle layouts, aim assist, adjustable control size/opacity, and safe-area support. Portrait shows a rotate-device overlay and does not start gameplay.
- Hybrid aiming: desktop free aim plus optional soft lock; mobile target snapping and generous configurable aim assist. Detection escalates stealth encounters rather than instantly failing them.

### Vehicles and traffic

- Eight driveable classes: compact, sedan, muscle, sports, van, pickup, police cruiser, and motorcycle. The level-five police helicopter is AI-only.
- Arcade handling uses responsive throttle, forgiving grip, tunable drift, handbrake turns, simplified suspension raycasts, collision boxes, and automatic upright recovery. Each class has distinct acceleration, top speed, mass, grip, turn response, durability, and cargo capacity.
- Any ambient road vehicle can be stolen. Up to eight owned vehicles can be stored. A stolen civilian vehicle becomes owned after a registration fee at Moreno Garage; police vehicles cannot be registered.
- Garage upgrades have three tiers for engine, brakes, grip, armor, and cosmetic paint. Damage covers body, engine, and four tires; zero engine health disables rather than explodes the vehicle. Repair kits restore partial health in the field.
- Traffic follows a lane graph with intersection yielding, obstruction recovery, panic behavior, siren yielding, district-specific spawn tables, and deterministic pooling.

### Combat, stealth, enemies, and police

- Weapon classes: melee/unarmed, pistol, SMG, shotgun, and rifle. Each firearm has three quality tiers that vary damage, recoil, capacity, durability, and value. No sniper rifle, explosives, heavy weapon, or throwable weapon in v1.
- Simple brawling uses one-button combo chains, charged heavy attacks, block, dodge, and stamina. Soft cover uses crouch, shoulder swap, corner peeking, and aim exposure without snap-to-cover nodes.
- Optional stealth uses crouching, line of sight, light level, noise events, takedowns, suppressors, and suspicion states. Alarms change reinforcements and objectives; detection never causes an arbitrary instant failure.
- Five enemy roles share common AI but receive faction skins and tuned loadouts: brawler, gunner, flanker, heavy, and marksman. AI states are patrol, investigate, suspicious, engage, reposition, flee/surrender, incapacitated.
- Violence is stylized and non-graphic: brief abstract hit particles, no blood pools, no dismemberment, no execution cinematics, and defeated NPCs ragdoll briefly before being pooled.
- Crimes produce witness and camera reports rather than instant omniscience. Breaking line of sight begins a search phase; leaving the search area and remaining unseen clears heat.
- Wanted levels: **1** investigating foot patrols; **2** armed officers and cruisers; **3** roadblocks, tire strips, and flank cars; **4** tactical vans, armored heavies, and marksmen; **5** helicopter spotlight, rooftop marksmen, reinforced roadblocks, and aggressive vehicle tactics. No military response.
- Death or arrest returns Alex to a clinic or station, removes 10% of carried cash plus carried contraband, preserves XP/properties/stash, and offers restart from the latest mission checkpoint.

### RPG progression

- Level cap 20. Authored missions supply most XP; first completion of activities and discoveries supplies secondary XP. Each level after 1 grants one skill point; every even level grants one attribute point.
- Five attributes start at 1 and cap at 6: **Grit** (+10 health and +5% melee per added point), **Aim** (-5% spread and -3% reload time), **Handling** (+4% vehicle stability/braking and +2% vehicle durability), **Nerve** (-5% heat gain and +5% enemy suspicion time), and **Hustle** (+5% cash and contact reputation).
- Three eight-node skill trees use one point per node. Tier 2 requires two nodes in that tree; capstones require five. The two capstones in each tree are mutually exclusive.

| Tree | Six regular nodes | Exclusive capstones |
|---|---|---|
| Combat | Steady Hands (recoil), Fast Hands (reload), Thick Skin (damage resistance), Second Wind (small heal after takedown), Street Fighter (melee/stamina), Scavenger (ammo recovery) | Deadeye (short focus/aim window) **or** Juggernaut (low-health resistance) |
| Driving | Road Grip (traction), Gearhead (repair efficiency), Handbrake Ace (drift control), Ram Plate (impact resistance), Heat Sink (vehicle search escape), Trunk Master (cargo space) | Ghost Driver (rapid line-of-sight loss) **or** Road Warrior (ramming/durability) |
| Streetcraft | Silver Tongue (discounts), Side Hustle (activity rewards), Light Fingers (faster theft/locks), Salvager (extra components), Property Mogul (income cap), Shadow (stealth/noise) | Kingpin (cash/reputation) **or** Operator (hack speed/objective intel) |

### Tactical inventory and crafting

- Backpack is an 8×6 grid with item shapes and a base 20 kg limit plus 2 kg per Grit point. It stores weapons, four ammunition calibers, armor, consumables, five crafting components, contraband, and quest items. Quest items have zero weight and cannot be discarded.
- Quick loadout supports two firearms, one melee slot, and two consumable slots. A safehouse stash has unlimited abstract capacity; vehicle trunks use a 6×4 grid modified by class and Trunk Master.
- Durability runs 0–100. Weapon accuracy/reliability degrades below 25 and items become unusable at 0 until repaired. Armor absorbs damage and loses durability. Inventory and crafting pause the single-player simulation.
- Utility crafting is available only at safehouse benches: handgun/SMG/rifle/shotgun ammo, medkit, armor repair plate, suppressor, weapon repair kit, and vehicle repair kit. Materials are scrap, cloth, chemicals, electronics, and powder. Complete weapons and armor cannot be crafted.
- Desktop supports drag/drop, rotate, split stack, auto-sort, compare, and keyboard transfer. Touch supports tap-select, tap-destination, rotate, split, auto-sort, and large confirmation targets.

### Economy, shops, properties, and side content

- Cash is earned from missions, side activities, selling registered vehicles, property revenue, and loot. Major sinks are weapons/ammo, repairs, crafting, vehicle registration/upgrades, healing, clothing presets, and properties.
- Service types: Moreno Garage, weapon dealer, clothing kiosks, clinics/food, and property management.
- Five authored purchasable properties, each with one paid upgrade: **Breakwater Warehouse** (larger stash/component yield), **Neon Strand Club** (income/contact-rep bonus), **Alta Vista Print Shop** (wanted cooldown/registration discount), **Arroyo Diner** (healing items/health perk), and **Coastline Car Wash** (vehicle repair/heat-loss perk).
- Properties accrue one fixed payout after a completed story mission or side job, capped at three uncollected payouts. The upgrade costs 50% of purchase price and increases payout and perk effect by 50%. Moreno Garage is the starting safehouse and is not one of the five purchases.
- Five repeatable activity types: street races, courier runs, vehicle theft lists, bounty hunts, and property defense. Each uses seeded variants, three difficulty bands, best-score/time tracking, scaled rewards, and a cooldown that prevents farming one trivial route.
- Exploration sets: 30 salvage caches, 20 stunt jumps, and 10 hacker signal nodes. Each has map reveal rules, persistent completion, rewards relevant to crafting/driving/Streetcraft, and a category completion bonus.

### Navigation, HUD, audio, and accessibility

- HUD: health/armor/stamina, ammo/durability, wanted stars/search radius, mission objective, contextual prompt, vehicle health/speed, minimap, radio station, XP/reputation notifications, and touch controls when applicable.
- Navigation: rotating minimap, full-screen district map, fog-of-discovery, filters, custom waypoint, objective markers, and A* route guidance over the road graph. Guidance renders the next road segments rather than a costly continuous world spline.
- Menus/HUD are responsive semantic HTML/CSS over the WebGL canvas and driven by a typed state store. WebGL renders the world only; it does not own text-heavy UI.
- Three procedural Web Audio radio stations, each with three original instrumental loops: **Coastline FM** (electronic), **Low Tide Radio** (hip-hop-inspired beats), and **Rustwave 88** (garage rock). Text-only station IDs replace voice hosts. Music state persists across vehicle entry/exit.
- Procedural SFX cover UI, engines, impacts, weapons, rain, sirens, and ambience; small original noise buffers may be bundled where synthesis is insufficient. Browser audio starts only after explicit user interaction.
- Accessibility baseline: remappable keyboard controls, aim-assist levels, touch sizing/opacity, camera sensitivity, subtitle size/background, reduced motion and camera shake, high-contrast objective/wanted indicators, UI scale, and independent master/music/SFX/UI/ambience sliders. Meaning never depends on color alone.

### Splash and raster assets

- Use the built-in image generation workflow for project-bound raster art. Required first asset: `public/assets/splash/heatline-splash.webp`, a text-free 16:9 stylized low-poly coastal crime-action scene with negative space for live HTML title/buttons. Keep all game title text in HTML for reliability and accessibility.
- Generate additional raster assets only when they improve the shipped result: social preview image, three contact portraits, and optional ending cards. Each distinct asset gets a distinct generation call, is visually inspected, converted/optimized locally, copied into the project, and recorded in the progress log with its final prompt.
- Do not generate simple UI icons; create those as deterministic CSS or project-native SVG. Do not use third-party game art, trademarks, or recognizable commercial characters/vehicles.

#### Generated asset ledger

| Date | Final project asset | Generation mode | Final prompt | Inspection and optimization |
|---|---|---|---|---|
| 2026-07-16 | `public/assets/splash/heatline-splash.webp` | Built-in ImageGen, new raster generation | `Use case: stylized concept art. Asset type: text-free 16:9 game splash-screen background for HEATLINE: SOLARA. Show an original bright coastal crime-action city at orange sunset after rain, colorful low-poly architecture, palm-lined roads, ocean and port, an original angular teal sports car in the right foreground, and a mechanic silhouette in a warm garage at far right. Preserve broad dark teal negative space across the left third for accessible live HTML title and buttons. Cinematic wide composition, polished game key art, teal/orange palette, crisp faceted shapes, atmospheric depth. No text, logos, trademarks, recognizable commercial vehicles or characters, weapons, gore, blood, UI, or watermark.` | Original PNG visually inspected at 1672×941. Converted locally with `cwebp` quality 82/sharp YUV; final WebP visually inspected at 119 KB. |

## Technical architecture

### Stack and repository

- Vite 7.3.x, TypeScript 5.9.x, Three.js 0.180.x, vanilla DOM/CSS UI, IndexedDB, Web Audio, Vitest for unit/integration tests, and Playwright for browser smoke/e2e tests.
- Strict TypeScript, ESLint without rewrite-on-test, deterministic seeded content, no runtime CDN imports, and no backend.
- Repository scripts: `dev`, `build`, `preview`, `typecheck`, `lint`, `test`, `test:e2e`, `check` (typecheck + lint + unit + build), and `deploy` (build only; GitHub Actions performs Pages upload/deploy).
- Vite uses relative production assets (`base: './'`) so branch/repository Pages paths work. The GitHub workflow installs locked dependencies, runs `npm run check`, uploads `dist`, and deploys only from the default branch after checks pass.

### Runtime boundaries

- `GameApp` owns startup, fixed-step update, interpolation/render, pause/focus behavior, quality selection, and teardown.
- Systems communicate through a typed event bus and read/write one authoritative serializable `GameState`; render objects and transient AI objects never enter saves.
- Fixed simulation step is 1/60 s with a capped accumulator; rendering runs at display cadence. Background tabs pause simulation and audio. A seeded RNG replaces `Math.random()` in gameplay and generation.
- Core systems: input, player, camera, interaction, world/chunk streaming, navigation, traffic, vehicle, pedestrian, combat, stealth, police, mission, progression, inventory, economy/property, collectibles, audio, weather/time, save, UI, and performance governor.
- Spatial hash broadphase handles nearby actors/collisions. Static world collision uses simplified boxes/planes and authored ramp/step metadata. Nav uses district road graphs plus a coarse pedestrian grid; no heavyweight WASM physics dependency.

### Public data contracts

The following versioned interfaces are stable boundaries and must remain serializable or explicitly transient:

- `GameState`: mode, clock/weather, player state, active district/cell, mission runtime, world flags, traffic seed, wanted state, settings reference, and dirty/save timestamp.
- `SaveGameV1`: schema version, slot metadata, Alex preset, transform, level/XP/attributes/skills, inventory/stash/trunks, owned vehicles, mission/contact states, ending, properties, activities, collectibles, money, world flags, and playtime.
- `WorldChunkManifest` and `WorldChunkDefinition`: id, district, bounds, neighbors, seed, static geometry recipes, roads, spawn zones, nav nodes, interiors, required assets, and hash/version.
- `MissionDefinition`: id, contact, prerequisites, reputation/level gates, start trigger, ordered objective graph, checkpoints, rewards, fail/restart behavior, dialogue keys, weather/time override, and world cleanup.
- `ObjectiveDefinition`: reach, interact, collect, race/checkpoint, escort, defend, eliminate, evade, stealth/hack, choice, or composite; each has explicit targets, completion conditions, optional timeout, and fallback.
- `ItemDefinition`, `RecipeDefinition`, `SkillNodeDefinition`, `VehicleDefinition`, `PropertyDefinition`, `ActivityDefinition`, `CollectibleDefinition`, `RadioStationDefinition`, and `DialogueEntry` live in validated data registries, not hard-coded UI branches.
- `GameEventMap` defines typed events for damage, crime/witness report, wanted change, inventory transaction, objective progress, mission lifecycle, chunk lifecycle, vehicle state, XP/reputation, save lifecycle, audio/radio, and UI notifications.

### Streaming and loading flow

1. Load only HTML/CSS, engine shell, menu, splash, settings, save metadata, and the Arroyo Heights starter manifest.
2. On New/Continue, generate/load the starter cell while showing deterministic progress and tips.
3. Predict the next cell from player velocity/road route; fetch manifest/code/data for current plus adjacent cells. Commit a cell only after required collision/nav data is ready.
4. Maintain an LRU of two inactive cells on desktop and one on mobile; preserve mission-critical actors until the mission releases them.
5. On fetch failure, retry twice with backoff, keep the player inside loaded bounds with an in-world road closure, and show Retry/Return to Menu. Never allow the player to fall into unloaded space.
6. Chunk hashes and save schema versions are independent. Old saves migrate before play; incompatible future saves fail safely without overwriting the original export.

### Save behavior

- IndexedDB stores three save slots plus settings. Autosave occurs at mission checkpoints/completion, purchases, property/skill changes, collectible completion, and every 90 seconds while safe and not in combat/pursuit.
- Writes use a temporary record then transactional pointer swap. Keep the last known-good snapshot per slot. Quota/write failure shows a persistent warning and offers JSON export.
- Exported JSON includes schema/version and checksum; import validates shape, ranges, registry ids, checksum, and migration before offering a destination slot. Never execute imported content.

## Implementation milestones and progress

### M0 — Ground truth and bootstrap — `COMPLETE`

- [x] Resolve product decisions and GitHub Pages/content conflict.
- [x] Create this canonical plan and progress protocol.
- [x] Create the Vite/TypeScript/Three project, package scripts, strict config, directory architecture, and Git repository.
- [x] Add a minimal canvas/DOM shell, deterministic loop, typed events/state, placeholder procedural scene, settings bootstrap, and smoke test.
- [x] Sync the sandbox staging project to `/Users/logge/Documents/GTA-Web`.

Acceptance: `npm run check` passes; menu starts a deterministic 3D scene; resize/focus/mobile-orientation handling works; `plan.md` exists at the canonical path.

### M1 — Input, player, camera, interaction, and UI shell — `COMPLETE`

- [x] Desktop and touch input abstraction with rebinding and safe-area landscape UI.
- [x] Player locomotion/traversal, camera modes/collision, interaction targeting, pause/focus.
- [x] HUD shell, pause/settings, unsupported-browser and rotate overlays.

Acceptance: keyboard/mouse and emulated touch both complete a movement/interaction course; no stuck input after blur; reduced motion and UI scaling work.

Completion evidence: the running world uses one remappable keyboard/mouse/touch action layer, multi-button pointer handling, focus/visibility teardown, landscape touch layouts, and a binding-capture UI. Alex's walk/sprint/jump/crouch/vault/mantle/ladder movement, aim/orbit/shoulder and vehicle chase cameras, contextual vehicle/portal interaction, pause/focus behavior, accessibility settings, unsupported-browser fallback, and portrait rotation blocker are integrated. The desktop and compact browser acceptance matrix passed with no stuck-input or overlay regressions.

### M2 — City generation, streaming, navigation, time, and weather — `COMPLETE`

- [x] Four district manifests, deterministic procedural blocks/roads/landmarks, collision/nav, key interior loader.
- [x] Chunk prediction/LRU/failure boundaries, minimap/full map/GPS, day-night and rain.
- [x] Adaptive LOD, instancing, pooling, resolution/density governor.

Acceptance: traverse all districts and one interior without gaps; forced chunk failure recovers safely; route guidance reaches cross-city targets; shell stays below the initial-load budget.

Completion evidence and implemented scope:

- Four deterministic 256 m district manifests, landmark/road/collision/navigation data, time-of-day lighting, authored rain windows, and a small rain-grip effect are active in gameplay. The Alta Vista finale tower is assigned to the correct district coordinate, and chunk identity is protected by a canonical hash of the full payload excluding only the hash field.
- Streaming maintains the current cell plus its eight neighbors as the active safety envelope, predicts movement/route demand, and keeps a bounded inactive LRU of two cells on desktop or one on mobile. Adaptive performance control governs density, actor budgets, and resolution while preserving recovery at ordinary 60 Hz frame timing.
- Cell residency is real rather than telemetry-only: lazy GPU payload roots are created for resident cells, deterministically recreated after eviction, and recursively disposed when evicted; cells begin with zero payload roots. Global roads/ground remain shared, collision is restricted to active cells, and portal visuals follow resident-cell state.
- Five authored interior scenes and their portal visuals are integrated, including a verified enter/exit round trip through Moreno Garage. Portal interaction receives priority when eligible so exiting a nearby vehicle cannot block an interior transition.
- Navigation includes road-graph A*, cross-city GPS guidance, rotating minimap/full map, discovery fog, authored markers, and custom waypoints. Off-road clicks snap to a reachable road destination, failed-cell route edges close, and the responsive map uses a stable render host so SVG redraws do not destroy its controls.
- Streaming failures retry twice, close affected roads in routing, create a visible hazard barrier with collision, and clamp the player to loaded space. An accessible blocking overlay offers Retry or Return to Menu while simulation pauses and resumes safely. A query-gated QA fault injector verifies both recovery branches without exposing production mutation controls.
- City simulation now drives actual pooled traffic and pedestrian meshes rather than counters alone. Adaptive actor limits flow into the simulation, district traversal updates real actor populations, and snapshots/HUD telemetry report the same live counts.
- The production e2e command rebuilds before previewing, and the QA bridge is available only behind `?qa=1`. Acceptance coverage exercises four-district traversal, bounded GPU/collision residency, live populations, Moreno Garage round trip, cross-city GPS arrival, and forced failure Retry/Return in the applicable desktop and compact-mobile projects.
- The Preview 1 pre-publication gate passed: `npm run check` completed 40 test files / 244 tests; the full Playwright suite completed 14 passed / 8 intentional project-specific skips; visual QA passed at 1280×720 and 844×390, including the full map and Moreno Garage; the production artifact is 0.83 MiB total / 0.31 MiB compressed.

### M3 — Vehicles, traffic, ownership, and garage — `COMPLETE`

- [x] Eight vehicle classes, arcade handling/damage/camera, enter/exit/theft, touch layouts.
- [x] Lane traffic, yielding/panic/police interaction, vehicle pooling.
- [x] Ownership, garage slots, registration, upgrades, repair, trunk inventory.

Acceptance: each class is distinct and driveable; traffic does not deadlock during a five-minute route; owned/upgraded/damaged vehicles survive save/load.

Completion evidence: all eight silhouettes and handling profiles are hot-swappable and driveable; the live lane graph maintains its fixed pool across district seams and completed a deterministic 300-second generated-city route without deadlock; police sirens cause live traffic to yield; the eight-slot garage rejects police vehicles and persists civilian identity, class, upgrades, paint, trunk contents, damage, repair, and retrieval across reloads. The 1280×720 desktop browser pass covered driving, garage controls, paint, and exterior rendering. The 844×390 compact-mobile browser course covered touch entry, throttle/steering, camera drag, handbrake, vehicle camera, recovery, exit, and portrait blocking. `npm run check` passed 48 test files / 301 tests, the full Playwright matrix passed 16 tests / 10 intentional project-specific skips, and the production artifact is 0.96 MiB total / 0.34 MiB compressed.

### M4 — Combat, stealth, NPC AI, and wanted system — `COMPLETE`

- [x] Five weapon classes/tiers, simple melee, soft cover, aim assist, durability/ammo/armor.
- [x] Pedestrians and five combat roles with nav, perception, reactions, pooling.
- [x] Witness reporting, five wanted levels, pursuit/search/roadblocks/tactical helicopter, death/arrest.

Acceptance: stealth and loud paths both resolve an encounter; each enemy role demonstrates its behavior; all wanted levels escalate and clear; content remains non-graphic.

Completion evidence: all 15 authored weapons are selectable and use distinct tier handling, ammunition, reload, recoil, wear, reliability, and durability; melee supports light chains, charged heavy attacks, blocking, stamina, guard breaks, dodges, and crouch-context non-graphic takedowns; soft cover, shoulder peeking, hybrid desktop/mobile aim assist, armor absorption, and abstract impacts are active in the live world. The deterministic combat NPC runtime supplies the five role-specific tactics, navigation, vision/hearing/light/noise/cover perception, suspicion, engagement, repositioning, retreat/surrender, and bounded pooling. Crimes flow through real pedestrian witnesses into the persistent wanted runtime; pursuit/search clearing, road-graph-anchored physical roadblocks, response budgets, the AI-only tactical helicopter, and clinic/station defeat penalties are integrated. The tutorial safe zone remains free of ambient hostile fire. `npm run check` passed 62 files / 375 tests; the full Playwright matrix passed 18 tests / 12 intentional project-specific skips; focused desktop and 844×390 M4 courses passed stealth, loud combat, every weapon/role, wanted levels 1–5, roadblocks, helicopter, and arrest; desktop visual QA passed both clear and level-five response states; the production artifact is 1.03 MiB total / 0.36 MiB compressed.

### M5 — RPG, inventory, crafting, economy, and properties — `PENDING`

- [ ] XP/level/attributes and all 24 skill nodes with prerequisites/exclusive capstones.
- [ ] Grid/weight/durability inventory, stash/trunks, touch transfers, recipes.
- [ ] Shops, economy, five properties/upgrades/income and ending modifiers.

Acceptance: level/build choices alter measured behavior; inventory rejects invalid placement/weight and survives save/load; property payout caps and purchases cannot duplicate money.

### M6 — Campaign, dialogue, activities, and exploration — `PENDING`

- [ ] Data-driven objective/checkpoint/dialogue framework and mission log/contact reputation.
- [ ] Implement and individually test all 12 authored missions and both endings.
- [ ] Five repeatable activities and all 60 collectibles with map/reward/save integration.

Acceptance: a clean save can finish every mission in valid open order, recover from every checkpoint, reach either ending, and continue free roam; no mission-only state leaks into the world.

### M7 — Audio, generated art, polish, and accessibility — `PENDING`

- [ ] Generate, inspect, optimize, and integrate the splash/social raster art through built-in image generation.
- [ ] Three stations/nine tracks, procedural SFX/ambience, radio persistence and mixer.
- [ ] Final responsive HUD/menu/map/inventory/skills/property/dialogue presentation and accessibility pass.

Acceptance: generated assets are local and credited in the progress log; audio unlock/resume/mix works; UI is usable at 1280×720, 1920×1080, 844×390, and 667×375 landscape.

### M8 — Persistence, QA, optimization, and release — `PENDING`

- [ ] Three-slot IndexedDB save, autosave/backup/migrations/export/import and corruption/quota handling.
- [ ] Unit/integration/e2e suites, cross-browser checks, memory/performance/load budgets, final copy/content audit.
- [ ] Production build and GitHub Actions Pages workflow; repository creation, push, deploy, live URL smoke test.

Acceptance: all checks below pass, deployment workflow is green, live GitHub Pages playthrough reaches gameplay on desktop and mobile viewport, assets stream under the repository base path, and the final URL is recorded here.

## Test plan

### Automated

- Unit: seeded RNG/generation snapshots, fixed-step clock, event bus, settings/bindings, attribute/skill math, inventory grid/weight/stack/durability, crafting transactions, economy/property caps, XP/reputation gates, wanted transitions/search, road A*, cell LRU, save checksum/migrations/validation.
- Integration: player/vehicle enter-exit, crime-to-witness-to-wanted flow, damage/death/arrest, purchase/upgrade/save/load, mission objective graphs/checkpoints/cleanup, both finale branches, chunk failure/retry, radio persistence, touch action mapping.
- Browser e2e: splash → new slot → presentation → prologue start; continue existing slot; settings/rebind; inventory/map/skills; desktop Chrome/Firefox/WebKit; 844×390 touch emulation; portrait rotation block; production base-path asset loading.
- Build gates: strict typecheck, lint, unit/integration tests, production build, bundle budget report, missing-asset scan, and no uncaught console errors in e2e.

### Manual and performance

- Complete all missions in at least two legal contact orders and both endings; intentionally fail each unique set piece at early/mid/late checkpoints.
- Drive every vehicle class, trigger all wanted levels, buy/upgrade all properties, craft every recipe, activate every skill, and verify all activities/collectible categories.
- Run 20-minute soak tests on desktop and emulated mobile; verify bounded actor/geometry/audio pools and no monotonic heap growth.
- Measure high/low quality on a current desktop and representative mobile browser. Target 60/30 FPS respectively, no frame over 250 ms during ordinary chunk transitions, and no first-play application shell over 20 MB compressed.
- Verify keyboard-only menu navigation, high contrast, subtitle scaling, reduced motion/shake, touch hit sizes, safe areas, independent audio controls, and loss/recovery of WebGL/audio context where supported.

## Release and publication

- Create a new public GitHub repository named `GTA-Web` under the authenticated user's account; default branch `main`.
- Commit intentionally by milestone, push only passing states, and use `.github/workflows/pages.yml` with official GitHub Pages actions. No secrets are required for the static game.
- Publish playable intermediate builds regularly, not only at final release. Required preview cadence: **Preview 0** after M0 (menu → city → movement/vehicle shell), **Preview 1** after M2 (four-district world/streaming/navigation), **Preview 2** after M4 (vehicles/combat/wanted loop), **Preview 3** after M6 (complete campaign/RPG/content), **Release Candidate** after M7, and **Final** after M8. A preview is published only from a passing commit; each live commit and smoke-test result is appended to the progress log.
- Keep generated/build artifacts out of source except project-bound optimized assets. Publish only `dist` through the Pages artifact.
- Add README with original-project disclaimer, controls, browser requirements, non-graphic mature crime-content note, local development, tests, and live link.
- After deployment, open the live URL, verify HTML/JS/chunks/images/audio and a new save in desktop and mobile viewports, then record the repository URL, Pages URL, commit SHA, build size, and check results below.

## Progress log

| Date/time (Europe/Berlin) | Milestone | Update | Evidence |
|---|---|---|---|
| 2026-07-16 | M0 | Goal created; complete grilling decisions consolidated; GitHub Pages/graphic-content conflict resolved in favor of non-graphic violence; ground-truth plan authored. | Goal active; this file |
| 2026-07-16 | M0 | User required regular playable Pages previews; Preview 0/1/2/3, RC, and Final publication gates added. | Release and publication section |
| 2026-07-16 | M0 | Bootstrapped pinned Vite/TypeScript/Three/Vitest/Playwright/ESLint project, responsive menu/HUD/touch shell, procedural Web Audio layer, README, and official Pages Actions workflow. Parallel core/data/world modules are in progress. | Initial build and typecheck passed before parallel integration; `src/ui`, `src/audio`, workflow |
| 2026-07-16 | M0 / M7 | Generated, inspected, optimized, and integrated the original text-free splash art through the built-in ImageGen workflow. | `public/assets/splash/heatline-splash.webp`; 1672×941 WebP; 119 KB; generated asset ledger |
| 2026-07-16 14:16 | M0 | Bootstrap acceptance passed. The menu launches the deterministic Three.js city shell, Alex can move and enter/exit the starter vehicle, IndexedDB Continue works, and map/pause/touch/portrait behaviors were smoke-tested. | `npm run check`: 25 files / 132 tests; `npm run test:e2e`: 4 passed / 4 project-specific skips; desktop and 844×390 visual QA; 0.68 MiB artifact / 0.26 MiB compressed shell |
| 2026-07-16 14:16 | M2 / M4 / M5 / M6 foundations | Added verified but not yet fully UI-integrated road A*/GPS and 256 m chunk streaming, pooled traffic/pedestrian/five-role combat simulations, progression/inventory/economy/campaign/wanted systems, 12-mission/60-collectible registries, and mission/dialogue runtimes. These do not mark later milestones complete until their end-to-end acceptance checks pass. | Unit/integration suite included in the 132 passing tests; `src/navigation`, `src/simulation`, `src/systems`, `src/data`, `src/runtime` |
| 2026-07-16 14:21 | M0 | The first remote gate exposed two late-arriving restore validation cases. Dialogue restore now preserves its current line when earlier content is removed, and mission restore rejects malformed numeric objective/checkpoint progress without mutation. | Focused runtime tests: 14/14; full `npm run check`: 25 files / 132 tests |
| 2026-07-16 14:25 | Preview 0.1 | Published the corrected M0 build through the GitHub Pages workflow and smoke-tested the live repository-base URL through splash, save/preset selection, and rendered gameplay. Also visually checked the live 844×390 gameplay layout. | Source `159b4179d646204069668bad7d8ae74c0f8cba85`; tag `preview-0.1`; [successful workflow](https://github.com/LoggeL/GTA-Web/actions/runs/29497909734); [live preview](https://loggel.github.io/GTA-Web/) |
| 2026-07-16 14:52 | M1 / M2 integration | Unified remappable keyboard/mouse/touch input now drives the running world; blur, visibility, multi-button mouse, focus, touch teardown, traversal, aim camera, shoulder swap, contextual vehicle entry/exit, live accessibility settings, A* GPS, discovered-cell fog, markers, responsive full map, and navigation/chunk telemetry are integrated. Desktop interaction/map/GPS smoke passed; visual streaming, binding capture UI, and final M1 browser matrix remain before the milestone gate. | 32 test files / 183 tests passed; focused desktop Playwright 5/5; build 0.74 MiB artifact / 0.28 MiB compressed shell |
| 2026-07-16 17:00 | M1 | Completed the unified desktop/touch input, rebinding, traversal, camera, interaction, pause/focus, settings, accessibility, unsupported-browser, and landscape/portrait UI acceptance scope. Desktop and compact browser validation found no stuck-input, scaling, or overlay regression. | M1 checklist and completion evidence above; included in 40 files / 244 passing tests and the full Playwright gate |
| 2026-07-16 17:00 | M2 | Completed the four-district streamed city: canonical chunk integrity, active/resident/LRU safety boundaries, real lazy GPU creation/eviction/disposal, active-cell collision, five interiors, Moreno Garage round trip, A*/GPS/map/discovery/custom waypoint navigation, day/night and rain grip, adaptive real traffic/pedestrian populations, road-closure collision/routing, and accessible forced-failure recovery. | `npm run check`: 40 files / 244 tests; Playwright: 14 passed / 8 intentional skips; 1280×720 and 844×390 visual QA including map and Moreno Garage; 0.83 MiB artifact / 0.31 MiB compressed |
| 2026-07-16 17:50 | Preview 1 | Published the complete M1/M2 four-district streaming/navigation build through GitHub Pages. Live smoke passed through splash/menu, an existing save into gameplay, vehicle entry, and the full map at desktop 1280×720 and compact 844×390; repository-base assets loaded successfully. | Source `0ba4478c7bc08a34f1f9ffbd83d7a36db119decd`; tag `preview-1`; [successful workflow](https://github.com/LoggeL/GTA-Web/actions/runs/29503687202); [live preview](https://loggel.github.io/GTA-Web/); 0.83 MiB uploaded artifact / 0.31 MiB compressed shell; `npm run check` 40 files / 244 tests; Playwright 14 passed / 8 intentional skips |
| 2026-07-16 17:55 | M3 | Began the vehicle/traffic/ownership/garage milestone with parallel implementation of the eight-class arcade handling and integrity registry plus the pure ownership, finite-slot garage, upgrade, repair, and trunk domain. | M3 marked `IN PROGRESS`; acceptance remains open until runtime, UI, persistence, touch, and soak gates pass |
| 2026-07-16 18:00 | M3 | Completed the vehicle, traffic, ownership, garage, and vehicle-specific touch scope and advanced the active implementation focus to M4. | `npm run check`: 48 files / 301 tests; Playwright: 16 passed / 10 intentional project-specific skips; deterministic 300-second generated-city traffic route; desktop 1280×720 visual QA; compact-mobile 844×390 touch course; 0.96 MiB artifact / 0.34 MiB compressed |
| 2026-07-16 18:10 | Preview 1.1 | Published the complete M3 vehicle/traffic/ownership/garage build through GitHub Pages. Live smoke passed through splash, menu, existing-save load, rendered gameplay, starter-vehicle entry, engine-health HUD, and the garage panel; deployed repository-base JS/CSS hashes matched the checked production build. | Source `89fbbb2ed2d01a060df2d3c0539bfdac3e4fa794`; tag `preview-1.1`; [successful workflow](https://github.com/LoggeL/GTA-Web/actions/runs/29509656104); [live preview](https://loggel.github.io/GTA-Web/?preview=1.1); 0.96 MiB artifact / 0.34 MiB compressed; `npm run check` 48 files / 301 tests; Playwright 16 passed / 10 intentional skips |
| 2026-07-16 18:11 | M4 | Completed the live combat/stealth/NPC/wanted milestone: 15 weapons, brawling and takedowns, soft cover and aim assist, five-role perception/navigation/tactics, witness-driven heat, persistent pursuit/search, physical roadblocks, tactical helicopter, armor, and death/arrest recovery. The authored combat zone was moved away from the tutorial garage after the full matrix exposed unsafe hostile proximity. | `npm run check`: 62 files / 375 tests; Playwright: 18 passed / 12 intentional project-specific skips; M4 desktop/mobile course 2 passed / 2 intentional skips; deterministic 300-second NPC soak; desktop clear/level-five visual QA; 1.03 MiB artifact / 0.36 MiB compressed |
| 2026-07-16 18:14 | Preview 2 | Published the complete M4 vehicles/combat/wanted loop through GitHub Pages. Live desktop smoke migrated and loaded the existing Preview 1.1 save, rendered the level-five response with three planned roadblocks and a tracking helicopter, exposed the 175 m search radius and active weapon HUD, and loaded the checked JS/CSS hashes. A fresh 844×390 live-mobile run reached gameplay with all nine on-foot touch actions, level-five response telemetry, and no page errors. | Source `0b4b5a0a94efefad1e6d48681fceec7714ad13a9`; tag `preview-2`; [successful workflow](https://github.com/LoggeL/GTA-Web/actions/runs/29514132955); [live preview](https://loggel.github.io/GTA-Web/?preview=2); 1.03 MiB artifact / 0.36 MiB compressed; `npm run check` 62 files / 375 tests; Playwright 18 passed / 12 intentional skips |

## Release record

- Repository: `https://github.com/LoggeL/GTA-Web`
- GitHub Pages URL: `https://loggel.github.io/GTA-Web/`
- Current preview: Preview 2 (`preview-2`)
- Release commit: `0b4b5a0a94efefad1e6d48681fceec7714ad13a9`
- Deployment workflow: [GitHub Pages run 29514132955 — success](https://github.com/LoggeL/GTA-Web/actions/runs/29514132955)
- Initial compressed shell: 0.26 MiB at Preview 0 gate
- Current compressed shell: 0.36 MiB at Preview 2 gate
- Published artifact size: 1.03 MiB at Preview 2 gate
- Final `npm run check`: pending for M8; Preview 2 gate passed with 62 files / 375 tests
- Final browser smoke test: pending for M8; Preview 2 live smoke passed existing-save migration/load, level-five response, three roadblocks, tracking helicopter, wanted-search/weapon HUD, checked repository-base JS/CSS hashes, and a fresh 844×390 mobile start with all nine on-foot touch actions and no page errors
