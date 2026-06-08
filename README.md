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

## File layout

```
index.html          markup + HUD
css/style.css        retro CRT-ish styling
js/config.js         all tunables: tile/grid sizes, unit & vehicle stat tables
js/utils.js          math/grid helpers
js/pathfinding.js    dynamic A* (handles destructible walls)
js/entities.js       Unit / Flag / Factory / Fort / Projectile / FX
js/sectors.js        territory model + flag state machine
js/ai.js             per-unit FSM + enemy commander
js/input.js          mouse/keyboard control + HUD/build panel
js/game.js           world generation, main loop, queries, rendering
```

Balance everything from `js/config.js` — unit stats, sector speed multiplier,
fort HP, aggro radius, and map dimensions all live there.
