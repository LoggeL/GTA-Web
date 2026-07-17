# HEATLINE: SOLARA

*HEATLINE: SOLARA* is an original single-player, third-person crime-action RPG built for modern desktop and mobile browsers. Play as Alex Moreno, explore four districts, work a 12-mission campaign across three contact storylines, take five repeatable activities, discover 60 city secrets, build combat/driving/streetcraft skills, and decide who controls Solara.

This project is an independent genre exercise. It is not associated with, endorsed by, or derived from Rockstar Games, Take-Two Interactive, Grand Theft Auto, or any other commercial game. All names, code, story, missions, music, world layouts, and project assets are original.

> Content note: mature crime themes, strong text dialogue, and stylized non-graphic action violence.

## Current release

Play **HEATLINE: SOLARA v1.0.0** at **[loggel.github.io/GTA-Web](https://loggel.github.io/GTA-Web/)**. The verified release tag, source commit, deployment, and earlier previews are recorded in [plan.md](./plan.md).

## Controls

| Action | Keyboard and mouse |
|---|---|
| Move / drive | WASD |
| Camera / aim | Mouse |
| Fire / light attack | Left mouse |
| Aim | Right mouse |
| Sprint | Shift |
| Jump / handbrake | Space |
| Crouch / vehicle camera | C |
| Interact / enter / exit | E |
| Melee | F |
| Reload / vehicle reset | R |
| Shoulder swap | Q |
| Weapon radial | Tab |
| Inventory | I |
| Map | M |
| Jobs and mission log | J |
| Pause | Esc |

Landscape mobile play uses a virtual movement stick, right-side camera drag, contextual action buttons, and aim assist. Menus remain usable in portrait; active gameplay pauses and asks the player to rotate.

## Browser requirements

Use a current Chrome, Edge, Firefox, or Safari release with WebGL2 and hardware acceleration enabled. Desktop gameplay requires a keyboard and mouse; mobile gameplay is designed for a landscape touch viewport. Web Audio is required for sound, but the game remains playable if audio cannot start.

Persistent progress requires IndexedDB and available browser storage. When storage is unavailable, HEATLINE clearly switches to a session-only mode: the current tab remains playable, but progress is lost when it closes. The interface also provides checked JSON exports for local backups and emergency recovery.

## Local development

Requires Node.js 24 and npm.

```bash
npm install
npm run dev
```

Verification:

```bash
npm run check
npm run test:e2e
```

### Physical Android performance acceptance

The final mobile hardware gate uses Chrome on a USB-connected Android phone through ADB/CDP. It refuses emulator, generic-device, mismatched-model, software-renderer, background-tab, and portrait runs. Use a dedicated browser profile or an empty HEATLINE save slot, keep the phone unlocked in landscape, and disable battery-saving or thermal-throttling modes for the course.

After enabling USB debugging and accepting the phone's RSA prompt, confirm the exact model with `adb shell getprop ro.product.model`, then run:

```bash
HEATLINE_ANDROID_SERIAL='device-serial-from-adb' \
HEATLINE_ANDROID_EXPECT_MODEL='exact adb model' \
HEATLINE_ANDROID_SECONDS=120 \
npm run test:performance:android
```

Physical acceptance requires an exact match in the reviewed mid-range model/device allowlist in [`android-performance-evidence.ts`](./tests/performance/android-performance-evidence.ts); unknown devices fail pending a sourced profile review, and a typed label cannot promote a flagship. The runner also verifies the immutable v1.0.0 HTML/JS/CSS/image SHA-256 set, requires WebGL2 with a named hardware renderer, records visibility/focus/orientation across the full course, measures one-second windows around ordinary cell transitions, enforces at least 120 seconds at 30.00 FPS, and deletes only its newly created save slot afterward.

Set `HEATLINE_ANDROID_CLEAR_ORIGIN=1` only on a dedicated test profile when all three save slots are occupied; it clears HEATLINE's origin storage before measuring. A passing physical run retains the serial-free JSON record under `evidence/performance/android/`. `HEATLINE_ALLOW_EMULATOR=1` exists solely to validate the runner infrastructure and can never produce accepted hardware evidence.

Production preview:

```bash
npm run build
npm run preview
```

## Architecture and status

[plan.md](./plan.md) is the canonical implementation specification and progress ledger. It defines all systems, mission content, interfaces, acceptance criteria, preview releases, and final publication checks.

The game uses Vite, strict TypeScript, Three.js, semantic HTML/CSS UI, IndexedDB saves, Web Audio, Vitest, and Playwright. The production build is static and needs no backend.
