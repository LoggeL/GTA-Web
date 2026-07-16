# HEATLINE: SOLARA

*HEATLINE: SOLARA* is an original single-player, third-person crime-action RPG built for modern desktop and mobile browsers. Play as Alex Moreno, explore four districts, work a 12-mission campaign across three contact storylines, take five repeatable activities, discover 60 city secrets, build combat/driving/streetcraft skills, and decide who controls Solara.

This project is an independent genre exercise. It is not associated with, endorsed by, or derived from Rockstar Games, Take-Two Interactive, Grand Theft Auto, or any other commercial game. All names, code, story, missions, music, world layouts, and project assets are original.

> Content note: mature crime themes, strong text dialogue, and stylized non-graphic action violence.

## Current playable preview

Play the latest passing build at **[loggel.github.io/GTA-Web](https://loggel.github.io/GTA-Web/)**. Preview tags and verified source commits are recorded in [plan.md](./plan.md).

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

Landscape mobile play uses a virtual movement stick, right-side camera drag, contextual action buttons, and aim assist. Portrait orientation displays a rotate-device prompt.

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
