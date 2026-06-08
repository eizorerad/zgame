/* =========================================================================
 * game.js — world generation, main loop, world queries, rendering.
 * G is the single global game object every other module talks to.
 * ========================================================================= */

const G = {
  player: TEAM.BLUE,
  units: [],
  sectors: [],
  factories: [],
  forts: [],
  projectiles: [],
  fx: [],
  scorch: [],                // ground burn decals left by explosions
  walls: new Map(),         // key -> hp  (destructible sandbags)
  terrain: null,            // Uint8Array of TERR.* values
  decor: [],                // non-blocking scenery (cacti, etc.)
  time: 0,
  dt: 0,
  running: false,
  over: false,

  /* ---- terrain helpers ------------------------------------------------ */
  tkey(tx, ty) { return ty * CFG.COLS + tx; },

  tilePassable(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= CFG.COLS || ty >= CFG.ROWS) return false;
    const t = this.terrain[this.tkey(tx, ty)];
    if (t === TERR.CLIFF || t === TERR.WATER) return false;
    if (t === TERR.WALL && this.walls.get(this.tkey(tx, ty)) > 0) return false;
    return true;
  },
  tilePassableIgnoreWall(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= CFG.COLS || ty >= CFG.ROWS) return false;
    const t = this.terrain[this.tkey(tx, ty)];
    return t !== TERR.CLIFF && t !== TERR.WATER;     // only solid terrain blocks
  },
  isWall(tx, ty) {
    return this.terrain[this.tkey(tx, ty)] === TERR.WALL && this.walls.get(this.tkey(tx, ty)) > 0;
  },
  terrainAt(px, py) {
    const tx = Util.tx(px), ty = Util.ty(py);
    if (tx < 0 || ty < 0 || tx >= CFG.COLS || ty >= CFG.ROWS) return TERR.SAND;
    return this.terrain[this.tkey(tx, ty)];
  },
  damageWall(tx, ty, dmg) {
    const k = this.tkey(tx, ty);
    if (this.terrain[k] !== TERR.WALL) return;
    const hp = (this.walls.get(k) || 0) - dmg;
    if (hp <= 0) { this.walls.delete(k); this.terrain[k] = TERR.SAND; this.fx.push(new Explosion(Util.cx(tx), Util.cy(ty), 10)); }
    else this.walls.set(k, hp);
  },

  // a unit sitting near a friendly fort or factory slowly repairs
  nearFriendlyDepot(u) {
    const R2 = CFG.REPAIR_RANGE * CFG.REPAIR_RANGE;
    for (const f of this.forts)
      if (f.alive && f.team === u.team && Util.dist2(u.x, u.y, f.x, f.y) <= R2) return true;
    for (const f of this.factories)
      if (f.alive && f.team === u.team && Util.dist2(u.x, u.y, f.x, f.y) <= R2) return true;
    return false;
  },

  freeSpotNear(px, py) {
    const cx = Util.tx(px), cy = Util.ty(py);
    for (let r = 0; r <= 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const tx = cx + dx, ty = cy + dy;
          if (this.tilePassable(tx, ty)) return { x: Util.cx(tx), y: Util.cy(ty) };
        }
      }
    }
    return { x: px, y: py };
  },

  /* ---- queries -------------------------------------------------------- */
  actualBuildTime(base, team) {
    return base / Sectors.speedMultiplier(team);
  },

  unitCount(team) {
    let n = 0;
    for (const u of this.units) if (u.alive && u.team === team && u.crewed) n++;
    return n;
  },

  nearestEnemyUnit(x, y, team, range) {
    let best = null, bd = range * range;
    for (const u of this.units) {
      if (!u.alive || !u.crewed) continue;
      if (u.team === team || u.team === TEAM.NEUTRAL) continue;
      const d = Util.dist2(x, y, u.x, u.y);
      if (d < bd) { bd = d; best = u; }
    }
    return best;
  },

  nearestEnemyTarget(x, y, team, range) {
    let best = null, bd = range * range;
    const consider = (e) => {
      if (!e || !e.alive) return;
      if (e.team === team || e.team === TEAM.NEUTRAL) return;
      const d = Util.dist2(x, y, e.x, e.y);
      if (d < bd) { bd = d; best = e; }
    };
    for (const u of this.units) { if (u.crewed) consider(u); }
    for (const f of this.forts) consider(f);
    for (const f of this.factories) consider(f);
    return best;
  },

  unitAt(px, py) {
    let best = null, bd = Infinity;
    for (const u of this.units) {
      if (!u.alive) continue;
      const r = u.radius + 4;
      const d = Util.dist2(px, py, u.x, u.y);
      if (d <= r * r && d < bd) { bd = d; best = u; }
    }
    return best;
  },

  factoryAt(px, py) {
    for (const f of this.factories) {
      if (!f.alive) continue;
      if (px >= f.x - CFG.TILE && px <= f.x + CFG.TILE &&
          py >= f.y - CFG.TILE && py <= f.y + CFG.TILE) return f;
    }
    return null;
  },

  fortAt(px, py) {
    for (const f of this.forts) {
      if (!f.alive) continue;
      if (px >= f.x - f.w / 2 && px <= f.x + f.w / 2 &&
          py >= f.y - f.h / 2 && py <= f.y + f.h / 2) return f;
    }
    return null;
  },

  spawnProjectile(attacker, target, sniper) {
    this.projectiles.push(new Projectile(attacker, target, sniper));
  },

  /* ===================================================================== */
  init() {
    const canvas = document.getElementById("game");
    canvas.width = CFG.COLS * CFG.TILE;
    canvas.height = CFG.ROWS * CFG.TILE;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;

    UI.init();
    Input.init(canvas);
    Sprites.build();

    this._buildWorld();
    this._cacheBackground();

    this.commander = new Commander(TEAM.RED);

    UI.showOverlay(
      "ZONE WARS",
      "A retro real-time-tactics battle in the spirit of Z.\n\n" +
      "Territory is time: every sector you hold builds your army faster. " +
      "Capture flags by touching them, crew abandoned vehicles, snipe enemy drivers, " +
      "and win by wiping out the enemy, smashing their fort, or sneaking a single " +
      "unit into their fort entrance.\n\n" +
      "You are BLUE. Good luck, commander.",
      "START BATTLE",
      () => this.start()
    );

    // render one static frame behind the overlay
    this._render();
  },

  start() {
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this._frame.bind(this));
  },

  /* ---- world generation ---------------------------------------------- */
  _buildWorld() {
    const N = CFG.COLS * CFG.ROWS;
    this.terrain = new Uint8Array(N);          // all SAND (0)

    // scrub patches (slow going)
    for (let i = 0; i < 18; i++) this._blob(Util.randInt(4, CFG.COLS - 4), Util.randInt(3, CFG.ROWS - 3), Util.randInt(1, 3), TERR.SCRUB, 0.7);

    // cliff mesas — keep them out of the central fort lane
    const lane = Math.floor(CFG.ROWS / 2);
    for (let i = 0; i < 13; i++) {
      const cy = Util.randInt(3, CFG.ROWS - 3);
      if (Math.abs(cy - lane) < 4) continue;
      this._blob(Util.randInt(8, CFG.COLS - 8), cy, Util.randInt(1, 3), TERR.CLIFF, 0.78);
    }

    // corner water lakes (impassable) with a couple of decorative inlets
    this._blob(CFG.COLS - 5, 4, 3, TERR.WATER, 0.85);
    this._blob(5, CFG.ROWS - 5, 3, TERR.WATER, 0.85);

    // scatter cacti decoration on open sand
    for (let i = 0; i < 60; i++) {
      const tx = Util.randInt(1, CFG.COLS - 2), ty = Util.randInt(1, CFG.ROWS - 2);
      if (this.terrain[this.tkey(tx, ty)] === TERR.SAND && Util.chance(0.5))
        this.decor.push({ tx, ty, x: Util.cx(tx), y: Util.cy(ty), h: Util.randInt(4, 7) });
    }

    // ---- sectors: 4 x 3 grid -----------------------------------------
    const SC = 4, SR = 3;
    let id = 0;
    for (let r = 0; r < SR; r++) {
      for (let c = 0; c < SC; c++) {
        const x = Math.floor(c * CFG.COLS / SC);
        const y = Math.floor(r * CFG.ROWS / SR);
        const w = Math.floor((c + 1) * CFG.COLS / SC) - x;
        const h = Math.floor((r + 1) * CFG.ROWS / SR) - y;
        const sec = new Sector(id++, { x, y, w, h });
        // flag at sector centre, on a guaranteed-clear tile
        const fx = x + Math.floor(w / 2), fy = y + Math.floor(h / 2);
        this._clearArea(fx, fy, 1);
        sec.flag = new Flag(sec, Util.cx(fx), Util.cy(fy));
        this.sectors.push(sec);
      }
    }

    // home sectors: left-middle = blue, right-middle = red
    const blueHome = this.sectors[1 * SC + 0];   // row1,col0
    const redHome = this.sectors[1 * SC + 3];    // row1,col3
    blueHome.owner = TEAM.BLUE;
    redHome.owner = TEAM.RED;

    // ---- factories ----------------------------------------------------
    // home sectors get a robot + vehicle factory; some neutral sectors get one.
    this._addFactory(blueHome, "robot", -2, -2);
    this._addFactory(blueHome, "vehicle", 2, 2);
    this._addFactory(redHome, "robot", 2, -2);
    this._addFactory(redHome, "vehicle", -2, 2);

    const neutralFactoryPlan = [
      [0, "robot"], [2, "vehicle"], [3, "gun"],
      [4, "vehicle"], [7, "robot"], [9, "gun"],
      [10, "robot"], [11, "vehicle"],
    ];
    for (const [si, kind] of neutralFactoryPlan) {
      const s = this.sectors[si];
      if (s.owner === TEAM.NEUTRAL) this._addFactory(s, kind, 0, -2);
    }

    // ---- forts --------------------------------------------------------
    const bfx = blueHome.rect.x + 2, bfy = blueHome.rect.y + Math.floor(blueHome.rect.h / 2);
    const rfx = redHome.rect.x + redHome.rect.w - 3, rfy = redHome.rect.y + Math.floor(redHome.rect.h / 2);
    this._clearArea(bfx, bfy, 3); this._clearArea(rfx, rfy, 3);
    this.forts.push(new Fort(TEAM.BLUE, Util.cx(bfx), Util.cy(bfy), { x: bfx, y: bfy }));
    this.forts.push(new Fort(TEAM.RED, Util.cx(rfx), Util.cy(rfy), { x: rfx, y: rfy }));

    // ---- starting armies ---------------------------------------------
    this._spawnSquad(TEAM.BLUE, Util.cx(bfx + 3), Util.cy(bfy), ["grunt", "grunt", "psycho", "sniper"]);
    this._spawnSquad(TEAM.RED, Util.cx(rfx - 3), Util.cy(rfy), ["grunt", "grunt", "psycho", "sniper"]);
    // a neutral abandoned tank in the middle to fight over
    const mtx = Math.floor(CFG.COLS / 2), mty = Math.floor(CFG.ROWS / 2);
    this._clearArea(mtx, mty + 6, 1);
    this.units.push(new Unit("machine", "light", null, Util.cx(mtx), Util.cy(mty + 6)));

    // ---- roads + defensive sandbags (need fort/sector positions) ------
    this._carveRoads(blueHome, redHome);
    this._placeSandbags();
  },

  _inBounds(x, y) { return x >= 0 && y >= 0 && x < CFG.COLS && y < CFG.ROWS; },

  // organic cluster of a terrain type
  _blob(cx, cy, r, type, density) {
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++)
        if (this._inBounds(x, y) && Util.dist(cx, cy, x, y) <= r + 0.3 && Util.chance(density))
          this.terrain[this.tkey(x, y)] = type;
  },

  // lay a road tile, bridging where it crosses water
  _road(tx, ty) {
    if (!this._inBounds(tx, ty)) return;
    const k = this.tkey(tx, ty);
    this.terrain[k] = (this.terrain[k] === TERR.WATER) ? TERR.BRIDGE : TERR.ROAD;
    this.walls.delete(k);
  },

  _carveRoads(blueHome, redHome) {
    const lane = blueHome.rect.y + Math.floor(blueHome.rect.h / 2);
    // main highway linking the two forts straight across the middle
    for (let x = 0; x < CFG.COLS; x++) { this._road(x, lane); this._road(x, lane + 1); }
    // vertical connectors through each sector column centre
    for (let c = 0; c < 4; c++) {
      const cx = Math.floor((c + 0.5) * CFG.COLS / 4);
      for (let y = 0; y < CFG.ROWS; y++) this._road(cx, y);
    }
    // little spurs to every flag so sectors feel connected
    for (const s of this.sectors) {
      const fx = Util.tx(s.flag.x), fy = Util.ty(s.flag.y);
      const cx = Math.floor((Math.floor(fx / (CFG.COLS / 4)) + 0.5) * CFG.COLS / 4);
      const a = Math.min(cx, fx), b = Math.max(cx, fx);
      for (let x = a; x <= b; x++) this._road(x, fy);
    }
  },

  _placeSandbags() {
    // a destructible sandbag line bracketing the central highway gap,
    // so boxed-in units demonstrate shooting through walls.
    const midX = Math.floor(CFG.COLS / 2), lane = Math.floor(CFG.ROWS / 2);
    for (let dy = -5; dy <= 6; dy++) {
      const y = lane + dy;
      if (Math.abs(dy) <= 1) continue;            // leave the road open
      for (const x of [midX - 6, midX + 6]) {
        if (this.terrain[this.tkey(x, y)] === TERR.SAND && Util.chance(0.8)) {
          this.terrain[this.tkey(x, y)] = TERR.WALL;
          this.walls.set(this.tkey(x, y), 60);
        }
      }
    }
  },

  _clearArea(tx, ty, r) {
    for (let y = ty - r; y <= ty + r; y++)
      for (let x = tx - r; x <= tx + r; x++)
        if (this._inBounds(x, y)) { this.terrain[this.tkey(x, y)] = TERR.SAND; this.walls.delete(this.tkey(x, y)); }
    this.decor = this.decor.filter(d => Math.abs(d.tx - tx) > r || Math.abs(d.ty - ty) > r);
  },

  _addFactory(sector, kind, dx, dy) {
    const fx = sector.rect.x + Math.floor(sector.rect.w / 2) + dx;
    const fy = sector.rect.y + Math.floor(sector.rect.h / 2) + dy;
    this._clearArea(fx, fy, 1);
    const f = new Factory(sector, Util.cx(fx), Util.cy(fy), kind);
    sector.factories.push(f);
    this.factories.push(f);
  },

  _spawnSquad(team, x, y, types) {
    types.forEach((t, i) => {
      const s = this.freeSpotNear(x + (i % 2) * 16, y + Math.floor(i / 2) * 16);
      this.units.push(new Unit("infantry", t, team, s.x, s.y));
    });
  },

  /* ---- main loop ------------------------------------------------------ */
  _frame(now) {
    if (!this.running) return;
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.05) dt = 0.05;       // clamp big stalls
    this.dt = dt;
    this._update(dt);
    this._render();
    requestAnimationFrame(this._frame.bind(this));
  },

  _update(dt) {
    if (this.over) return;
    this.dt = dt;
    this.time += dt;

    this.commander.update(dt);

    for (const u of this.units) UnitAI.think(u);
    for (const u of this.units) u.update(dt);
    for (const f of this.factories) f.update(dt);
    for (const f of this.forts) f.update(dt);

    for (const p of this.projectiles) p.update(dt);
    for (const e of this.fx) e.update(dt);
    for (const s of this.scorch) s.t += dt;

    Sectors.checkCaptures();
    this._handleCrewing();
    this._cleanup();
    this._checkWin();

    UI.refreshHud();
    if (this.time % 0.5 < dt) UI.refreshFactoryPanel(); // keep build bars fresh
  },

  // any infantry touching an empty machine becomes its driver
  _handleCrewing() {
    for (const m of this.units) {
      if (!m.alive || m.kind !== "machine" || m.driver) continue;
      for (const inf of this.units) {
        if (!inf.alive || inf.kind !== "infantry") continue;
        if (Util.dist(inf.x, inf.y, m.x, m.y) <= m.radius + inf.radius) {
          m.driver = { team: inf.team };   // team now follows driver
          if (inf.selected) m.selected = true;
          // inherit the infantry's current order so it keeps doing its job
          if (inf.commandAttack) m.orderAttack(inf.commandAttack);
          else if (inf.moveGoalX != null) m.orderMove(inf.moveGoalX, inf.moveGoalY);
          inf.alive = false;      // soldier is now inside the vehicle
          break;
        }
      }
    }
  },

  _cleanup() {
    this.units = this.units.filter(u => u.alive);
    this.projectiles = this.projectiles.filter(p => p.alive);
    this.fx = this.fx.filter(e => e.alive);
    this.factories = this.factories.filter(f => f.alive);
    this.scorch = this.scorch.filter(s => s.t < s.life);
    if (this.scorch.length > 50) this.scorch.splice(0, this.scorch.length - 50);
  },

  _checkWin() {
    if (this.over || this.time < 2) return;
    const enemy = enemyOf(this.player);

    const decide = (winner, how) => { this._end(winner, how); };

    // Destruction
    const pf = this.forts.find(f => f.team === this.player);
    const ef = this.forts.find(f => f.team === enemy);
    if (ef && !ef.alive) return decide(this.player, "destroyed the enemy Fort");
    if (pf && !pf.alive) return decide(enemy, "destroyed your Fort");

    // Infiltration: a mobile unit reaches the enemy fort's entry tile
    for (const u of this.units) {
      if (!u.crewed) continue;
      const targetFort = this.forts.find(f => f.alive && f.team !== u.team && f.team !== TEAM.NEUTRAL);
      if (!targetFort) continue;
      if (Util.tx(u.x) === targetFort.entry.x && Util.ty(u.y) === targetFort.entry.y) {
        return decide(u.team, "infiltrated the enemy Fort");
      }
    }

    // Elimination
    if (this.unitCount(enemy) === 0) return decide(this.player, "eliminated all enemy units");
    if (this.unitCount(this.player) === 0) return decide(enemy, "eliminated all your units");
  },

  _end(winner, how) {
    this.over = true;
    const youWon = winner === this.player;
    UI.showOverlay(
      youWon ? "VICTORY" : "DEFEAT",
      `${winner === TEAM.BLUE ? "BLUE" : "RED"} ${how}.\n\nTime: ${Util.fmtTime(this.time)}`,
      "PLAY AGAIN",
      () => location.reload()
    );
  },

  /* ===================================================================== */
  _cacheBackground() {
    const bg = document.createElement("canvas");
    bg.width = this.canvas.width; bg.height = this.canvas.height;
    const c = bg.getContext("2d"); c.imageSmoothingEnabled = false;
    const T = CFG.TILE, K = CFG.COLORS;
    const at = (x, y) => (this._inBounds(x, y) ? this.terrain[this.tkey(x, y)] : TERR.SAND);

    for (let y = 0; y < CFG.ROWS; y++) {
      for (let x = 0; x < CFG.COLS; x++) {
        const t = this.terrain[this.tkey(x, y)];
        const X = x * T, Y = y * T;
        // sand underlay everywhere (so road/scrub edges blend)
        c.fillStyle = ((x + y) & 1) ? K.sand : K.sand2; c.fillRect(X, Y, T, T);
        if ((x * 7 + y * 13) % 5 === 0) { c.fillStyle = K.speck; c.fillRect(X + ((x * 5) % T), Y + ((y * 3) % T), 2, 2); }

        if (t === TERR.SCRUB) {
          c.fillStyle = K.sand3; c.fillRect(X, Y, T, T);
          c.fillStyle = K.scrub;
          for (let i = 0; i < 5; i++) c.fillRect(X + ((i * 5 + y) % (T - 2)), Y + ((i * 7 + x) % (T - 2)), 2, 2);
        } else if (t === TERR.ROAD) {
          c.fillStyle = K.road; c.fillRect(X, Y, T, T);
          c.fillStyle = K.roadLo; c.fillRect(X, Y, T, 2); c.fillRect(X, Y + T - 2, T, 2);
          // dashed centre line on the main horizontal lane
          if (at(x - 1, y) === TERR.ROAD && at(x + 1, y) === TERR.ROAD && (x & 1)) {
            c.fillStyle = K.roadLine; c.fillRect(X + 4, Y + T / 2 - 1, T - 8, 2);
          }
        } else if (t === TERR.WATER) {
          c.fillStyle = K.water; c.fillRect(X, Y, T, T);
          c.fillStyle = K.water2; c.fillRect(X, Y + T - 4, T, 4);
          c.fillStyle = K.waterHi; c.fillRect(X + 3, Y + 4, 5, 1); c.fillRect(X + 9, Y + 9, 4, 1);
        } else if (t === TERR.BRIDGE) {
          c.fillStyle = K.water; c.fillRect(X, Y, T, T);
          c.fillStyle = K.bridge; c.fillRect(X, Y + 1, T, T - 2);
          c.fillStyle = K.bridgeLo; for (let p = 0; p < T; p += 4) c.fillRect(X + p, Y + 1, 1, T - 2);
        } else if (t === TERR.CLIFF) {
          c.fillStyle = K.cliff; c.fillRect(X, Y, T, T);
          c.fillStyle = K.cliffHi; c.fillRect(X, Y, T, 3);                // lit top
          if (at(x, y + 1) !== TERR.CLIFF) { c.fillStyle = K.cliffLo; c.fillRect(X, Y + T - 4, T, 4); } // drop shadow
          if (at(x + 1, y) !== TERR.CLIFF) { c.fillStyle = K.cliffLo; c.fillRect(X + T - 3, Y, 3, T); }
          if (at(x - 1, y) !== TERR.CLIFF) { c.fillStyle = K.cliffHi; c.fillRect(X, Y, 2, T); }
          c.fillStyle = K.cliffLo; c.fillRect(X + 4, Y + 6, 2, 2); c.fillRect(X + 9, Y + 10, 2, 2); // pits
        }
      }
    }

    // cacti decorations
    for (const d of this.decor) {
      const X = d.x, Y = d.y;
      c.fillStyle = "rgba(0,0,0,0.25)"; c.fillRect(X - 2, Y + 3, 6, 2);     // shadow
      c.fillStyle = K.cactus; c.fillRect(X - 1, Y - d.h, 3, d.h + 3);        // trunk
      c.fillRect(X - 4, Y - d.h + 2, 3, 2); c.fillRect(X - 4, Y - d.h + 2, 2, 5); // left arm
      c.fillRect(X + 2, Y - d.h + 4, 3, 2); c.fillRect(X + 3, Y - d.h, 2, 6);     // right arm
      c.fillStyle = K.cactusHi; c.fillRect(X - 1, Y - d.h, 1, d.h);
    }
    this.bg = bg;
  },

  _render() {
    const ctx = this.ctx, T = CFG.TILE;
    ctx.drawImage(this.bg, 0, 0);

    // sector tints + borders
    for (const s of this.sectors) {
      const col = s.owner === TEAM.BLUE ? "77,166,255" : s.owner === TEAM.RED ? "255,91,91" : "150,150,150";
      ctx.fillStyle = `rgba(${col},${s.owner === TEAM.NEUTRAL ? 0.04 : 0.10})`;
      ctx.fillRect(s.px, s.py, s.pw, s.ph);
      // capture-in-progress: light up the whole square in the attacker's colour
      if (s.capProgress > 0 && s.capTeam) {
        const cc = s.contested ? "255,255,255"
                 : s.capTeam === TEAM.BLUE ? "77,166,255" : "255,91,91";
        ctx.fillStyle = `rgba(${cc},${0.05 + 0.16 * s.capProgress})`;
        ctx.fillRect(s.px, s.py, s.pw, s.ph);
      }
      if (s.flash > 0) { ctx.fillStyle = `rgba(${col},${0.25 * s.flash})`; ctx.fillRect(s.px, s.py, s.pw, s.ph); }
      ctx.strokeStyle = (s.capProgress > 0 && s.capTeam)
        ? (s.contested ? "rgba(255,255,255,0.7)" : `rgba(${s.capTeam === TEAM.BLUE ? "77,166,255" : "255,91,91"},0.8)`)
        : "rgba(0,0,0,0.55)";
      ctx.lineWidth = 2;
      ctx.strokeRect(s.px + 1, s.py + 1, s.pw - 2, s.ph - 2);
    }

    // destructible sandbag walls (dynamic — show wear as they take damage)
    for (const [k, hp] of this.walls) {
      const x = (k % CFG.COLS) * T, y = Math.floor(k / CFG.COLS) * T;
      const dmg = Util.clamp(hp / 60, 0, 1);
      ctx.fillStyle = "rgba(0,0,0,0.2)"; ctx.fillRect(x + 2, y + T - 3, T - 2, 3);
      for (let r = 0; r < 3; r++) for (let cc = 0; cc < 3; cc++) {
        if ((r * 3 + cc) / 9 > dmg) continue;            // bags blown away as HP drops
        ctx.fillStyle = (r + cc) & 1 ? CFG.COLORS.wall : CFG.COLORS.wallLo;
        ctx.fillRect(x + cc * 5 + 1, y + r * 5 + 1, 5, 5);
        ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(x + cc * 5 + 1, y + r * 5 + 4, 5, 1);
      }
    }

    this._drawScorch(ctx);
    this._drawFlags(ctx);
    this._drawFactories(ctx);
    this._drawForts(ctx);
    this._drawProjectiles(ctx);
    this._drawUnits(ctx);
    this._drawFx(ctx);            // fire/debris/smoke render on top of units
    this._drawSelectionBox(ctx);
    this._drawMinimap(ctx);
  },

  _drawScorch(ctx) {
    for (const s of this.scorch) {
      const a = 0.42 * (1 - s.t / s.life);
      PX.fillOval(ctx, s.x, s.y, s.r, s.r * 0.62, `rgba(18,12,8,${a})`, 2);
    }
  },

  _teamColor(team) {
    return team === TEAM.BLUE ? CFG.COLORS.blue : team === TEAM.RED ? CFG.COLORS.red : CFG.COLORS.neutral;
  },
  _teamDark(team) {
    return team === TEAM.BLUE ? CFG.COLORS.blueDk : team === TEAM.RED ? CFG.COLORS.redDk : "#666";
  },

  _drawFlags(ctx) {
    for (const s of this.sectors) {
      const f = s.flag; if (!f) continue;
      ctx.fillStyle = "#2a2a2a"; ctx.fillRect(f.x - 1, f.y - 14, 2, 18);   // pole
      // stepped pennant (pixel triangle)
      ctx.fillStyle = this._teamColor(s.owner);
      ctx.fillRect(f.x + 1, f.y - 14, 11, 2);
      ctx.fillRect(f.x + 1, f.y - 12, 8, 2);
      ctx.fillRect(f.x + 1, f.y - 10, 5, 2);
      ctx.fillStyle = "rgba(0,0,0,0.4)"; ctx.fillRect(f.x - 3, f.y + 3, 6, 2);

      // capture meter — a pixel ring that fills clockwise from the top
      if (s.capProgress > 0 && s.capTeam) {
        PX.ring(ctx, f.x, f.y - 2, 9, "rgba(0,0,0,0.5)", 2, 4, 1);
        PX.ring(ctx, f.x, f.y - 2, 9, s.contested ? "#ffffff" : this._teamColor(s.capTeam), 2, 4, s.capProgress);
        if (s.contested) { ctx.fillStyle = "#fff"; ctx.fillRect(f.x - 1, f.y - 12, 2, 2); }
      }
    }
  },

  _drawFactories(ctx) {
    const T = CFG.TILE;
    for (const f of this.factories) {
      const w = Math.round(T * 2.3), h = Math.round(T * 2.0);
      const x0 = Math.round(f.x - w / 2), y0 = Math.round(f.y - h / 2);
      const main = this._teamColor(f.team), dark = this._teamDark(f.team);

      // ground shadow
      ctx.fillStyle = "rgba(0,0,0,0.30)"; ctx.fillRect(x0 + 3, y0 + h - 2, w, 4);

      // concrete walls + corrugation
      ctx.fillStyle = "#3a3d42"; ctx.fillRect(x0, y0, w, h);
      ctx.fillStyle = "#2c2f33"; ctx.fillRect(x0, y0, w, h);
      ctx.fillStyle = "#43474d"; for (let i = 2; i < w - 1; i += 4) ctx.fillRect(x0 + i, y0 + 7, 2, h - 9);
      ctx.fillStyle = "#23262a"; ctx.fillRect(x0, y0 + h - 4, w, 4);     // base shade

      // pitched team-colour roof with stepped (pixel) sawtooth skylights
      ctx.fillStyle = dark; ctx.fillRect(x0, y0, w, 8);
      ctx.fillStyle = main;
      for (let i = 0; i < w - 1; i += 6) {
        ctx.fillRect(x0 + i, y0 + 5, 6, 2);
        ctx.fillRect(x0 + i + 1, y0 + 3, 4, 2);
        ctx.fillRect(x0 + i + 2, y0 + 1, 2, 2);
      }
      ctx.fillStyle = "rgba(255,255,255,0.25)"; ctx.fillRect(x0, y0, w, 1);

      // big roller door + emblem sign
      const dw = w - 12, dx = x0 + 6, dy = y0 + 11;
      ctx.fillStyle = "#15171a"; ctx.fillRect(dx, dy, dw, h - 15);
      ctx.fillStyle = "#202327"; for (let yy = dy + 2; yy < dy + h - 15; yy += 3) ctx.fillRect(dx + 1, yy, dw - 2, 1);
      ctx.fillStyle = dark; ctx.fillRect(dx - 1, dy - 1, dw + 2, 4);     // door header
      this._factoryGlyph(ctx, f.ftype, f.x, y0 + 5, main);

      // chimneys / type extras
      if (f.ftype === "gun") { ctx.fillStyle = "#15171a"; ctx.fillRect(f.x - 2, y0 - 5, 4, 6); ctx.fillRect(f.x + 1, y0 - 4, 8, 2); }
      else if (f.ftype === "robot") { ctx.fillStyle = "#15171a"; ctx.fillRect(x0 + w - 6, y0 - 6, 2, 7); ctx.fillStyle = main; ctx.fillRect(x0 + w - 7, y0 - 7, 4, 2); }
      else { ctx.fillStyle = "#15171a"; ctx.fillRect(x0 + 3, y0 - 4, 3, 5); ctx.fillRect(x0 + 8, y0 - 4, 3, 5); }

      // build progress bar
      if (f.team !== TEAM.NEUTRAL) {
        const frac = f.buildFraction();
        ctx.fillStyle = "#000"; ctx.fillRect(x0, y0 + h + 1, w, 3);
        ctx.fillStyle = main; ctx.fillRect(x0, y0 + h + 1, w * frac, 3);
      }
      if (f.hp < f.maxHp) this._bar(ctx, f.x, y0 - 8, w, f.hp / f.maxHp, "#7d7");
    }
  },

  // little pictograms on factory signs
  _factoryGlyph(ctx, type, cx, cy, col) {
    ctx.fillStyle = "#0c0d0f"; ctx.fillRect(cx - 8, cy - 4, 16, 9);
    ctx.fillStyle = col;
    if (type === "robot") {            // robot head
      ctx.fillRect(cx - 4, cy - 3, 8, 7);
      ctx.fillStyle = "#0c0d0f"; ctx.fillRect(cx - 2, cy - 1, 1, 2); ctx.fillRect(cx + 1, cy - 1, 1, 2);
      ctx.fillStyle = col; ctx.fillRect(cx - 1, cy - 5, 2, 2);
    } else if (type === "vehicle") {   // tank silhouette
      ctx.fillRect(cx - 6, cy + 1, 11, 3); ctx.fillRect(cx - 3, cy - 2, 6, 3); ctx.fillRect(cx + 2, cy - 1, 5, 2);
    } else {                            // crosshair
      PX.ring(ctx, cx, cy, 4, col, 1, 1, 1);
      ctx.fillRect(cx - 6, cy, 12, 1); ctx.fillRect(cx, cy - 6, 1, 12);
    }
  },

  _drawForts(ctx) {
    for (const f of this.forts) {
      const x = Math.round(f.x - f.w / 2), y = Math.round(f.y - f.h / 2);
      const W = f.w, H = f.h, main = this._teamColor(f.team), dark = this._teamDark(f.team);

      if (!f.alive) {                                  // rubble
        ctx.fillStyle = "#2a2622"; ctx.fillRect(x, y, W, H);
        ctx.fillStyle = "#1a1714";
        for (let i = 0; i < 26; i++) ctx.fillRect(x + (i * 13 % (W - 4)), y + (i * 7 % (H - 4)), 4, 3);
        continue;
      }

      ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fillRect(x + 3, y + H - 1, W, 5);  // shadow

      // courtyard floor
      ctx.fillStyle = "#26211b"; ctx.fillRect(x, y, W, H);
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      for (let gx = x + 8; gx < x + W; gx += 8) ctx.fillRect(gx, y, 1, H);

      // perimeter wall
      const t = 6;
      ctx.fillStyle = dark;
      ctx.fillRect(x, y, W, t); ctx.fillRect(x, y + H - t, W, t);
      ctx.fillRect(x, y, t, H); ctx.fillRect(x + W - t, y, t, H);
      ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.fillRect(x, y, W, 1);
      // battlement crenellations on top wall
      ctx.fillStyle = dark; for (let bx = x; bx < x + W; bx += 7) ctx.fillRect(bx, y - 3, 4, 4);

      // gate opening at the entry tile (knock a hole in the wall there)
      const ex = Util.cx(f.entry.x), ey = Util.cy(f.entry.y);
      ctx.fillStyle = "#26211b";
      ctx.fillRect(ex - 7, Math.abs(ey - y) < H / 2 ? y - 1 : y, 14, t + 2);     // clear top-wall section near entry
      ctx.fillStyle = main; ctx.fillRect(ex - 7, y - 1, 14, 2);                   // gate lintel
      ctx.fillStyle = "#0c0d0f"; ctx.fillRect(ex - 6, y, 12, t);                  // dark gateway
      ctx.fillStyle = main;                                                       // entry chevron (pixel)
      ctx.fillRect(ex - 4, ey - 4, 8, 2); ctx.fillRect(ex - 2, ey - 2, 4, 2); ctx.fillRect(ex - 1, ey, 2, 2);

      // corner turrets
      for (const [cxp, cyp] of [[x + t, y + t], [x + W - t, y + t], [x + t, y + H - t], [x + W - t, y + H - t]]) {
        PX.fillCircle(ctx, cxp, cyp, 4.5, "#15171a", 2);
        PX.fillCircle(ctx, cxp, cyp, 2.5, main, 2);
      }

      // central command keep with rotating main gun
      ctx.fillStyle = "#1b1d20"; ctx.fillRect(f.x - 11, f.y - 9, 22, 18);
      ctx.fillStyle = dark; ctx.fillRect(f.x - 11, f.y - 9, 22, 5);
      ctx.fillStyle = main; ctx.fillRect(f.x - 3, f.y - 8, 6, 3);                 // emblem
      const foe = this.nearestEnemyUnit(f.x, f.y, f.team, CFG.FORT_TURRET_RANGE * 2);
      const ang = foe ? Math.atan2(foe.y - f.y, foe.x - f.x) : 0;
      PX.line(ctx, f.x, f.y, f.x + Math.cos(ang) * 12, f.y + Math.sin(ang) * 12, "#0c0d0f", 2, 3);
      PX.fillCircle(ctx, f.x, f.y, 6, "#0c0d0f", 2);
      PX.fillCircle(ctx, f.x, f.y, 4, main, 2);

      this._bar(ctx, f.x, y - 8, W, f.hp / f.maxHp, main);
    }
  },

  _dirOf(ang) { return ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8; },

  _blit(ctx, img, x, y) {
    if (!img) return;
    ctx.drawImage(img, Math.round(x - img.width / 2), Math.round(y - img.height / 2));
  },

  _drawUnits(ctx) {
    for (const u of this.units) {
      const palTeam = u.team === TEAM.BLUE ? "blue" : u.team === TEAM.RED ? "red" : "neutral";

      // soft shadow (pixel oval)
      PX.fillOval(ctx, u.x, u.y + u.radius * 0.55, u.radius * 0.95, u.radius * 0.5, "rgba(0,0,0,0.28)", 2);

      if (u.kind === "machine") {
        const aim = this._dirOf(u.target ? u.facing : u.hullFacing);
        if (u.immobile) {
          this._blit(ctx, Sprites.gunBase(palTeam), u.x, u.y);
          this._blit(ctx, Sprites.gunTurret(palTeam, aim), u.x, u.y);
        } else {
          this._blit(ctx, Sprites.hull(u.typeKey, palTeam, this._dirOf(u.hullFacing)), u.x, u.y);
          this._blit(ctx, Sprites.turret(u.typeKey, palTeam, aim), u.x, u.y);
        }
        if (u.driver) this._bar(ctx, u.x, u.y - u.radius - 6, u.radius * 2 + 4, u.armour / u.maxArmour, "#e8c050");
      } else {
        const frame = u.moving ? (Math.floor(u.animClock) & 1) : 0;
        this._blit(ctx, Sprites.infantry(u.typeKey, palTeam, this._dirOf(u.facing), frame), u.x, u.y);
        this._bar(ctx, u.x, u.y - u.radius - 5, u.radius * 2 + 2, u.hp / u.maxHp, "#7d7");
      }

      // veterancy chevrons
      if (u.rank > 0) {
        ctx.fillStyle = u.rank >= 3 ? "#ffe24a" : "#e8e8e8";
        for (let i = 0; i < u.rank; i++) ctx.fillRect(u.x - 3 + i * 3, u.y + u.radius + 3, 2, 2);
      }
      if (u.selected) PX.brackets(ctx, u.x, u.y, u.radius + 5, "#9cff6a", 4, 2);
      if (u.holdPosition) PX.ring(ctx, u.x, u.y, u.radius + 7, "rgba(255,255,255,0.45)", 2, 2, 1);
    }
  },

  _drawMinimap(ctx) {
    const mw = 150, mh = mw * CFG.ROWS / CFG.COLS;
    const ox = this.canvas.width - mw - 8, oy = 8;
    const sx = mw / (CFG.COLS * CFG.TILE), sy = mh / (CFG.ROWS * CFG.TILE);
    ctx.fillStyle = "rgba(8,10,12,0.85)"; ctx.fillRect(ox - 2, oy - 2, mw + 4, mh + 4);
    // sectors
    for (const s of this.sectors) {
      const col = s.owner === TEAM.BLUE ? "rgba(77,166,255,0.5)" : s.owner === TEAM.RED ? "rgba(255,91,91,0.5)" : "rgba(120,110,90,0.5)";
      ctx.fillStyle = col;
      ctx.fillRect(ox + s.px * sx, oy + s.py * sy, s.pw * sx, s.ph * sy);
      ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 0.5;
      ctx.strokeRect(ox + s.px * sx, oy + s.py * sy, s.pw * sx, s.ph * sy);
    }
    // forts
    for (const f of this.forts) {
      if (!f.alive) continue;
      ctx.fillStyle = this._teamColor(f.team);
      ctx.fillRect(ox + f.x * sx - 2, oy + f.y * sy - 2, 4, 4);
    }
    // units
    for (const u of this.units) {
      if (!u.crewed) continue;
      ctx.fillStyle = this._teamColor(u.team);
      ctx.fillRect(ox + u.x * sx - 0.5, oy + u.y * sy - 0.5, u.kind === "machine" ? 2 : 1.4, u.kind === "machine" ? 2 : 1.4);
    }
    ctx.strokeStyle = "#2b3a44"; ctx.lineWidth = 1; ctx.strokeRect(ox - 2, oy - 2, mw + 4, mh + 4);
  },

  _bar(ctx, cx, y, w, frac, col) {
    frac = Util.clamp(frac, 0, 1);
    ctx.fillStyle = "#000"; ctx.fillRect(cx - w / 2, y, w, 3);
    ctx.fillStyle = col; ctx.fillRect(cx - w / 2, y, w * frac, 3);
  },

  _drawProjectiles(ctx) {
    for (const p of this.projectiles) {
      if (p.sniper) {
        PX.line(ctx, p.x, p.y, p.x - (p.tx - p.x) * 0.05, p.y - (p.ty - p.y) * 0.05, "#fff", 2, 2);
      } else {
        ctx.fillStyle = p.team === TEAM.BLUE ? "#bfe0ff" : p.team === TEAM.RED ? "#ffd0d0" : "#ffe";
        ctx.fillRect(Math.floor(p.x / 2) * 2, Math.floor(p.y / 2) * 2, 2, 2);
      }
    }
  },

  _drawExplosion(ctx, e) {
    // smoke (drawn first, behind the fire) — pixel puffs
    for (const s of e.smoke) {
      const st = e.t - s.delay; if (st < 0) continue;
      const p = st / s.life; if (p > 1) continue;
      const r = s.r * (0.6 + p * 1.8), sy = e.y - st * s.rise;
      PX.fillCircle(ctx, e.x + s.ox, sy, r, `rgba(70,64,58,${0.34 * (1 - p)})`, 2);
      PX.fillCircle(ctx, e.x + s.ox, sy, r * 0.6, `rgba(110,100,90,${0.20 * (1 - p)})`, 2);
    }

    // shockwave ring for big blasts
    if (e.shock && e.t < 0.18) {
      const p = e.t / 0.18;
      PX.ring(ctx, e.x, e.y, e.size * (0.6 + p * 1.6), `rgba(255,230,170,${0.6 * (1 - p)})`, 2, 2, 1);
    }

    // fireball — lumpy, white-hot core fading through orange (pixel blocks)
    for (const pf of e.puffs) {
      const pt = e.t - pf.delay; if (pt < 0) continue;
      const p = pt / e.fbDur; if (p > 1) continue;
      const r = pf.r * (0.45 + 0.65 * p), a = 1 - p;
      let col;
      if (p < 0.3) col = `rgba(255,255,235,${a})`;
      else if (p < 0.6) col = `rgba(255,205,70,${a})`;
      else col = `rgba(225,95,28,${a})`;
      PX.fillCircle(ctx, e.x + pf.ox, e.y + pf.oy, r, col, 2);
    }

    // flying debris (metal chunks + embers), snapped to the pixel grid
    for (const d of e.debris) {
      if (d.t >= d.life) continue;
      const a = 1 - d.t / d.life;
      const bx = Math.floor((e.x + d.x) / 2) * 2, by = Math.floor((e.y + d.y) / 2) * 2;
      ctx.fillStyle = `rgba(0,0,0,${0.25 * a})`;
      ctx.fillRect(bx, Math.floor((e.y + Math.max(0, d.y)) / 2) * 2 + 2, 2, 2);  // ground shadow
      if (d.hot) {
        PX.fillCircle(ctx, bx, by, d.s * 0.8 + 1, `rgba(255,${120 + ((a * 120) | 0)},40,${a})`, 2);
        ctx.fillStyle = `rgba(255,240,180,${a * 0.9})`; ctx.fillRect(bx, by, 2, 2);
      } else {
        const sz = Math.max(2, Math.round(d.s / 2) * 2);
        ctx.fillStyle = d.c; ctx.globalAlpha = a; ctx.fillRect(bx, by, sz, sz); ctx.globalAlpha = 1;
      }
    }
  },

  _drawFx(ctx) {
    for (const e of this.fx) {
      if (e instanceof Explosion) {
        this._drawExplosion(ctx, e);
      } else if (e instanceof Spark) {
        ctx.fillStyle = e.c; ctx.fillRect(Math.floor(e.x / 2) * 2 - 2, Math.floor(e.y / 2) * 2 - 2, 4, 4);
      } else if (e instanceof Tracer) {
        ctx.globalAlpha = 1 - e.t / e.life;
        PX.line(ctx, e.x1, e.y1, e.x2, e.y2, this._teamColor(e.team), 2, 2);
        ctx.globalAlpha = 1;
      } else if (e instanceof Muzzle) {
        const a = 1 - e.t / e.life;
        PX.fillCircle(ctx, e.x, e.y, 3 * a + 1, `rgba(255,230,140,${a})`, 2);
        ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.fillRect(Math.floor(e.x / 2) * 2, Math.floor(e.y / 2) * 2, 2, 2);
      } else if (e instanceof RankUp) {
        const a = 1 - e.t / e.life;                       // pixel up-chevron
        ctx.fillStyle = `rgba(255,226,74,${a})`;
        ctx.fillRect(e.x - 3, e.y, 6, 2); ctx.fillRect(e.x - 2, e.y - 2, 4, 2); ctx.fillRect(e.x - 1, e.y - 4, 2, 2);
      }
    }
  },

  _drawSelectionBox(ctx) {
    const d = Input.drag;
    if (!d) return;
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    ctx.strokeStyle = "#9cff6a"; ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.fillStyle = "rgba(156,255,106,0.08)"; ctx.fillRect(x, y, w, h);
  },
};

window.addEventListener("load", () => G.init());
