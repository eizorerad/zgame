# ZONE WARS

A pixel-art, real-time-tactics browser game built in the spirit of the 1996 Bitmap
Brothers classic **Z** — all momentum, aggression, and territory-as-time. No build
step, no dependencies: open `index.html` (or serve the folder statically) and play.

```
python3 -m http.server 8000   # then visit http://localhost:8000
```

## How to play

You command **BLUE**. The enemy **RED** is run by an aggressive AI commander.
The cursor is context-sensitive — it shows the order a right-click will give.

| Do this | Result |
|---|---|
| Left-click / drag a box (Shift adds) | Select your units (double-click = every unit of that type on screen) |
| Right-click ground | **MOVE** — go through; fire only at point-blank enemies, never chase off course |
| Right-click an enemy | **ATTACK** — pursue that target to the death |
| Right-click an enemy/neutral flag or sector | **CAPTURE** — move onto the flag to take the sector |
| Right-click a friendly **APC** | **BOARD** — selected infantry climbs in (4 seats); **U** unloads |
| **Shift** + any right-click | Queue the order after the current one |
| Press **A** then click | **ATTACK-MOVE** — advance and engage everything seen on the way |
| **Ctrl+1–9** / **1–9** | Save / recall a control group (double-tap jumps the camera to it) |
| Right-click the minimap | Order the selection to that point |
| **H** / **S** / **Esc** | Hold position / Stop / Deselect |
| **P** / **+ −** / **M** | Pause / game speed ×0.5–×2 / mute |
| Click your factory | Open its build panel; **right-click** sets its rally point |

- Walk infantry into an **empty (grey) vehicle** to crew it.
- **Snipers** drop a vehicle's driver with every **3rd hit** (2nd at Veteran rank), leaving the vehicle for anyone to grab. Passengers of a sniped APC bail out.
- **Tank shells and rockets are ballistic**: they fly to a predicted *point*, so fast units dodge and clumped armies eat splash — including **friendly fire** at 50%.
- **Line-of-sight**: cliffs and standing sandbags block direct fire; only rockets arc over them.

**Win three ways:** wipe out every enemy unit, destroy their Fort, or sneak a single unit onto the enemy Fort's entry tile (▼).

## How it maps to the design blueprint

| Blueprint section | Where it lives |
|---|---|
| **1. Sector-based resource logic** (territory == production speed, `time = base / (1 + sectors·mult)`, capture instantly recalculates all in-progress builds) | `js/sectors.js` (`speedMultiplier`), `js/entities.js` (`Factory.update` / `buildFraction`), `js/game.js` (`actualBuildTime`). Recalculation is continuous: factories read the live sector count every frame. |
| **2. Flag state machine** (no health bar, pure collision switch; flipping a sector retargets its factories and discards progress) | `js/sectors.js` (`Sector.setOwner`, `Sectors.checkCaptures`), `js/entities.js` (`Factory.onOwnerChanged`). |
| **3. "Dumb robot" AI & destructible pathfinding** (wide aggro, break orders to engage, attack walls to clear a blocked path) | `js/ai.js` (`UnitAI.think`), `js/pathfinding.js` (dynamic A* that returns the blocking wall), `js/entities.js` (`Unit._fightWall`). |
| **4. Vehicle hijacking & crew logic** (modular vehicle + driver reference; sniper bypass; empty vehicles go neutral and are re-crewable) | `js/entities.js` (`Unit` machine kind, `applyDamage` sniper branch, `ejectDriver`), `js/game.js` (`_handleCrewing`). |
| **5. Win conditions & hard targets** (Fort with auto-turrets; elimination / destruction / infiltration) | `js/entities.js` (`Fort`), `js/game.js` (`_checkWin`). |

## Deeper mechanics

Beyond the core blueprint the game models a number of *Z*-style systems:

| System | What it does | Where |
|---|---|---|
| **Veterancy** | Kills promote units (Rookie → Trained → Veteran → Hero); each rank adds damage, range, fire-rate and durability, shown as chevrons. Sniper crew-kills and tank crushes count. | `js/config.js` (`VET`), `js/entities.js` (`gainKill`, stat getters) |
| **Terrain & movement** | Sand (normal), **roads** (fast), **scrub** (slow), **cliffs/water** (impassable), **bridges** over water. | `js/config.js` (`TERRAIN_SPEED`), `js/game.js` (`terrainAt`, `_carveRoads`) |
| **Crushing** | Moving tanks/jeeps flatten enemy infantry they roll over. | `js/entities.js` (`_crush`) |
| **Repair depots** | Units idling near a friendly fort or factory slowly heal / re-armour. | `js/entities.js` (`_maybeRepair`), `js/game.js` (`nearFriendlyDepot`) |
| **Contested capture** | Flags are no longer flipped on touch — a unit fills a timed capture meter. Taking an *enemy* sector first neutralizes it (stopping its production) then claims it (~2× cost); both sides on the point freeze it (contested); leaving lets the meter decay. This kills the opening snowball and pushes the decisive fight into the midgame. | `js/config.js` (`CAPTURE_TIME`), `js/sectors.js` (`updateCapture`) |
| **Ballistic combat** | Cannon/rocket shots are aimed at a *predicted point* with scatter — dodgeable, splash with falloff, 50% friendly fire. Direct fire needs line-of-sight; rockets arc over obstacles (and walls/cliffs). | `js/entities.js` (`Projectile`), `js/game.js` (`hasLOS`, `splashAt`) |
| **APC transport** | A crewed APC carries 4 infantry (with their veterancy): right-click to board, **U** to unload; crew-sniped APCs spill their passengers, destroyed ones don't. | `js/entities.js` (`orderBoard`, `cargo`), `js/input.js` (`_unloadSelected`) |
| **Squad AI** | The enemy commander defends flipping sectors, grabs neutral flags with lone units, but assaults enemy territory in massed waves that grow over time — and counter-builds against your army's composition. | `js/ai.js` (`Commander._runSquad`, `_enemyVehicleShare`) |
| **Soft collision** | Mobile units push each other apart instead of stacking — and group moves are capped to the slowest member so formations arrive together. | `js/game.js` (`_separate`), `js/input.js` (`_formMove`) |
| **Procedural audio** | Every effect (per-weapon gunfire, explosions, capture fanfares, alarms, UI blips) is synthesized with WebAudio — no asset files, throttled per effect, distance-faded. | `js/sound.js` |
| **Minimap** | Live sector ownership + unit blips, top-right; right-click to order, red rings ping where your units are under attack. | `js/game.js` (`_drawMinimap`) |

## Pixel art

`js/sprites.js` is a procedural sprite factory. Each unit is hand-drawn pixel-by-pixel
facing east, then baked at load time into **8 rotated facings** (plus 4-frame walk
cycles for infantry). Vehicles bake the **hull and turret separately**, so tank
turrets track their target while the hull points along its path — and **kick back
with recoil** when the gun fires. The same art recolours per team (and grey for
abandoned vehicles) from `CFG.TEAM_PAL`. The map uses a desert tileset — shaded
cliff mesas, dashed roads, water with bridges, scrub, sandbags and cacti — drawn
once into a cached background.

The battlefield accumulates history as you fight: vehicles **leave tread marks**
on soft ground, fallen infantry stay as **fading corpses** in pools of blood,
explosions scorch the sand, and **damaged vehicles trail smoke** (grey when hurt,
black with embers when critical) so you can read at a glance who to finish off.
The fixed-resolution canvas scales up to fill the window in crisp half-integer
steps.

## File layout

```
index.html          markup + HUD
css/style.css        retro styling
js/config.js         all tunables: stats, terrain, veterancy, palettes
js/utils.js          math/grid helpers
js/sound.js          procedural WebAudio SFX (no asset files)
js/sprites.js        procedural pixel-art sprite factory (8-dir, animated)
js/pathfinding.js    dynamic A* (handles destructible walls)
js/entities.js       Unit / Flag / Factory / Fort / Projectile / FX
js/sectors.js        territory model + flag state machine
js/ai.js             per-unit FSM + squad-based enemy commander
js/input.js          mouse/keyboard control + HUD/build panel
js/game.js           world generation, main loop, queries, rendering
test/smoke.js        headless smoke test (node test/smoke.js, no browser)
```

Balance everything from `js/config.js` — unit stats, sector speed multiplier,
fort HP, aggro radius, ballistic scatter, friendly-fire fraction and map
dimensions all live there.

## Testing

`node test/smoke.js` stubs the DOM/Canvas/Audio and drives the real game loop
through several simulated minutes, asserting that production, AI capture,
ballistic combat, LOS, APC transport, order queueing and the decal caps all
behave.
