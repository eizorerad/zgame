# ZONE WARS

A pixel-art, real-time-tactics browser game built in the spirit of the 1996 Bitmap
Brothers classic **Z** — all momentum, aggression, and territory-as-time. No build
step, no dependencies: open `index.html` (or serve the folder statically) and play.

```
python3 -m http.server 8000   # then visit http://localhost:8000
```

## How to play

You command **BLUE**. The enemy **RED** is run by an aggressive AI commander.

- **Drag** a box to select your units.
- **Right-click** to move (or to attack an enemy unit / factory / fort).
- **Click one of your factories** to open the build panel and choose what it churns out; **right-click** while a factory is selected to set its rally point.
- **H** = hold position (units stop chasing and only fire at what enters weapon range), **S** = stop, **Esc** = deselect.
- Walk infantry into an **empty (grey) vehicle** to crew it.
- **Snipers** can punch through armour and kill a vehicle's driver outright, leaving the vehicle for anyone to grab.

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
| **Minimap** | Live sector ownership + unit blips, top-right. | `js/game.js` (`_drawMinimap`) |

## Pixel art

`js/sprites.js` is a procedural sprite factory. Each unit is hand-drawn pixel-by-pixel
facing east, then baked at load time into **8 rotated facings** (plus 2-frame walk
cycles for infantry). Vehicles bake the **hull and turret separately**, so tank
turrets track their target while the hull points along its path. The same art
recolours per team (and grey for abandoned vehicles) from `CFG.TEAM_PAL`. The map
uses a desert tileset — shaded cliff mesas, dashed roads, water with bridges,
scrub, sandbags and cacti — drawn once into a cached background.

## File layout

```
index.html          markup + HUD
css/style.css        retro styling
js/config.js         all tunables: stats, terrain, veterancy, palettes
js/utils.js          math/grid helpers
js/sprites.js        procedural pixel-art sprite factory (8-dir, animated)
js/pathfinding.js    dynamic A* (handles destructible walls)
js/entities.js       Unit / Flag / Factory / Fort / Projectile / FX
js/sectors.js        territory model + flag state machine
js/ai.js             per-unit FSM + enemy commander
js/input.js          mouse/keyboard control + HUD/build panel
js/game.js           world generation, main loop, queries, rendering
```

Balance everything from `js/config.js` — unit stats, sector speed multiplier,
fort HP, aggro radius, and map dimensions all live there.
