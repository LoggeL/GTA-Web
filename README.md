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

Production preview:

```bash
npm run build
npm run preview
```

## Architecture and status

[plan.md](./plan.md) is the canonical implementation specification and progress ledger. It defines all systems, mission content, interfaces, acceptance criteria, preview releases, and final publication checks.

The game uses Vite, strict TypeScript, Three.js, semantic HTML/CSS UI, IndexedDB saves, Web Audio, Vitest, and Playwright. The production build is static and needs no backend.
