# Kali’s Sudoku — VVIP launch theme asset pack (v1)

## Included themes
- 01_moonlight_conservatory: Moonlight Conservatory / 月光玻璃温室
- 02_celestial_observatory: Celestial Observatory / 星河天文台
- 03_sakura_moon_garden: Sakura Moon Garden / 樱月庭院

Each theme has `bg_desktop.webp` (1920x1080) and `bg_mobile.webp` (1080x1920), already rasterized to these output sizes.

**Image fidelity warning:** Moonlight uses standalone native 1672x941 / 941x1672 images, resized to the delivery targets. Observatory and Sakura are clean crops from a 1536x1024 six-scene concept sheet and upscaled; their *native detail is considerably lower* than 1920/1080 despite output dimensions. They are suitable for integration and visual prototyping, but should be replaced with individually rendered masters before monetized production. Do not market them as native 4K or native full-HD images.

## Growth decorative assets
`assets/overlays/flower_stage_0.svg` to `_3.svg`
`assets/overlays/constellation_stage_0.svg` to `_3.svg`
`assets/overlays/sakura_petals_stage_0.svg` to `_3.svg`
These are original transparent vector graphics, usable as DOM image overlays and scalable without raster quality loss. An SVG is not animation: Trae implements CSS/canvas motion/transitions. Not all overlays should appear simultaneously.

## Runtime requirements for Trae
- Use CSS `background-image` or `<picture>` source switching by viewport, keep the Sudoku board as a **separate interactive foreground layer**, never bake numbers or UI in images.
- Cover/crop appropriately, not stretch; include a translucent contrast panel under the board and high-contrast digits, notes, cage borders, selection and error feedback.
- In Discord Activities, check embedded iframe viewport, mobile safe areas and actual board visibility. Preserve Discord SDK and game integrations; no assumptions about Activity API availability.
- Theme changes must not reset player mode, puzzle, timer, multiplayer room or game state. Do not call startApp() or openModeSelectModal() on theme choice.
- Define theme IDs distinct from paid-entitlement identifiers; verify ownership on server before granting access; no purchase integration at this stage.
- Track growth per theme and user with idempotent completion events on the server; award only after validated game completion. Example prototype stages: 0 / 5 / 20 / 50 completed puzzles. Ensure multiplayer cannot double-credit; allow reduced motion and effects-off.
- Avoid background audio/autoplay and heavy continuous particle loops. Support Web/Discord responsive view with desktop and mobile assets.
- Keep free VIP wood, forest and ocean intact; VVIP is additive and should not change game mechanics or create competitive advantage.

## Manifest
See `theme_manifest.json`.
