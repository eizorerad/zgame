/* =========================================================================
 * game.js — world generation, main loop, world queries, rendering.
 * G is the single global game object every other module talks to.
 * ========================================================================= */

const G = {
  player: TEAM.BLUE,
  units: [],
  sectors: [],
  sectorOf: null,           // Int16Array: region id per tile
  factories: [],
  forts: [],
  projectiles: [],
  fx: [],
  scorch: [],                // ground burn decals left by explosions
  tracks: [],                // vehicle tread marks on soft ground
  corpses: [],               // fallen infantry, fading away
  pings: [],                 // minimap attack alerts
  paused: false,
  speedMult: 1,              // game speed (0.5 / 1 / 2)
  walls: new Map(),         // key -> hp  (destructible sandbags)
  terrain: null,            // Uint8Array of TERR.* values
  decor: [],                // non-blocking scenery (cacti, etc.)
  cam: { x: 0, y: 0 },      // camera (world px) — the map is larger than the viewport
  mana: { blue: 0, red: 0 },                                   // HQ comeback economy
  upgrades: { blue: { infAtk: 0, infDef: 0, vehAtk: 0, vehDef: 0 },
              red:  { infAtk: 0, infDef: 0, vehAtk: 0, vehDef: 0 } },
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

  // line-of-sight: a supercover tile walk between two points; cliffs and
  // standing sandbag walls block direct fire (rockets arc over them)
  hasLOS(x1, y1, x2, y2) {
    let tx = Util.tx(x1), ty = Util.ty(y1);
    const ex = Util.tx(x2), ey = Util.ty(y2);
    const dx = Math.abs(ex - tx), dy = Math.abs(ey - ty);
    const sx = tx < ex ? 1 : -1, sy = ty < ey ? 1 : -1;
    let err = dx - dy;
    while (tx !== ex || ty !== ey) {
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; tx += sx; }
      else { err += dx; ty += sy; }
      if (tx === ex && ty === ey) break;           // don't test the target's own tile
      const t = this.terrain[this.tkey(tx, ty)];
      if (t === TERR.CLIFF) return false;
      if (t === TERR.WALL && this.walls.get(this.tkey(tx, ty)) > 0) return false;
    }
    return true;
  },

  // decal helpers (capped so long games don't accumulate forever)
  addTrack(x, y, ang, spread) {
    this.tracks.push({ x, y, ang, spread, t: 0, life: 7 });
    if (this.tracks.length > 420) this.tracks.splice(0, this.tracks.length - 420);
  },
  addCorpse(u) {
    this.corpses.push({ x: u.x, y: u.y, typeKey: u.typeKey, team: u.team,
                        dir: ((Math.round(u.facing / (Math.PI / 4)) % 8) + 8) % 8, t: 0, life: 16 });
    if (this.corpses.length > 90) this.corpses.splice(0, this.corpses.length - 90);
  },
  // minimap attack alert (throttled so a firefight is one ping, not fifty)
  ping(x, y, force) {
    const now = this.time;
    for (const p of this.pings) {
      if (!force && now - p.born < 2.5 && Util.dist2(x, y, p.x, p.y) < 200 * 200) return;
    }
    this.pings.push({ x, y, born: now });
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

  // unit-type lookups (shared by factories, the HQ and mana builds)
  kindOf(type) { return INFANTRY_TYPES[type] ? "infantry" : "machine"; },
  baseTimeOf(type) { return (INFANTRY_TYPES[type] || VEHICLE_TYPES[type] || GUN_TYPES[type]).baseTime; },
  unitName(type) { return (INFANTRY_TYPES[type] || VEHICLE_TYPES[type] || GUN_TYPES[type]).name; },
  manaCost(type) { return Math.round(this.baseTimeOf(type) * 1.3); },

  // true when a team is at its population cap (continuous production pauses)
  atPopCap(team) { return this._pop ? this._pop[team] >= CFG.MAX_POP : false; },

  // spend mana to instantly spawn a unit at the team's HQ
  instantBuild(team, type) {
    const cost = this.manaCost(type);
    if (this.mana[team] < cost) return false;
    const fort = this.forts.find(f => f.alive && f.team === team);
    if (!fort) return false;
    this.mana[team] -= cost;
    const u = fort.spawn(type);
    this.fx.push(new RankUp(u.x, u.y));            // little spawn flourish
    return true;
  },

  // spend mana on an attack/defence upgrade level
  buyUpgrade(team, cat) {
    const up = this.upgrades[team];
    const lvl = up[cat];
    if (lvl >= CFG.UPGRADE_MAX) return false;
    const cost = CFG.UPGRADE_COST[lvl];
    if (this.mana[team] < cost) return false;
    this.mana[team] -= cost;
    up[cat] = lvl + 1;
    return true;
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

  // Pick a target inside `range`, weighted by the counter system: a unit
  // prefers enemies its damage type is strong against (effective distance =
  // real distance / multiplier), so bazookas drift to tanks, rifles to men.
  nearestEnemyTarget(x, y, team, range, dtype) {
    let best = null, bestScore = Infinity;
    const r2 = range * range;
    const consider = (e, cls) => {
      if (!e || !e.alive) return;
      if (e.team === team || e.team === TEAM.NEUTRAL) return;
      const d = Util.dist2(x, y, e.x, e.y);
      if (d > r2) return;
      const m = (dtype && DMG_MULT[dtype]) ? (DMG_MULT[dtype][cls] ?? 1) : 1;
      const score = d / (m * m);
      if (score < bestScore) { bestScore = score; best = e; }
    };
    for (const u of this.units) { if (u.crewed) consider(u, u.cls); }
    for (const f of this.forts) consider(f, "heavy");
    for (const f of this.factories) consider(f, "heavy");
    return best;
  },

  // ballistic impact: full damage at the centre falling off to 40% at the rim.
  // FRIENDLY units in the blast take CFG.SPLASH_FF of it — clumping is risky.
  splashAt(x, y, r, dmg, attacker) {
    const r2 = r * r;
    for (const u of this.units) {
      if (!u.alive || u === attacker) continue;
      if (u.kind === "machine" && !u.driver) continue;        // empty hulls are loot, not targets
      const d2 = Util.dist2(x, y, u.x, u.y);
      const rr = r + u.radius;
      if (d2 > rr * rr) continue;
      const fall = 1 - 0.6 * Math.sqrt(d2) / rr;
      const ff = (attacker && u.team === attacker.team) ? CFG.SPLASH_FF : 1;
      u.applyDamage(dmg * fall * ff, attacker, false);
    }
    // blasts also chew nearby structures
    for (const f of this.factories) {
      if (f.alive && Util.dist2(x, y, f.x, f.y) <= (r + 16) * (r + 16) && f.team !== (attacker && attacker.team))
        f.applyDamage(dmg * 0.4);
    }
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
  worldW() { return CFG.COLS * CFG.TILE; },
  worldH() { return CFG.ROWS * CFG.TILE; },
  clampCam() {
    this.cam.x = Util.clamp(this.cam.x, 0, Math.max(0, this.worldW() - CFG.VIEW_W));
    this.cam.y = Util.clamp(this.cam.y, 0, Math.max(0, this.worldH() - CFG.VIEW_H));
  },
  centerCam(x, y) { this.cam.x = x - CFG.VIEW_W / 2; this.cam.y = y - CFG.VIEW_H / 2; this.clampCam(); },

  init() {
    const canvas = document.getElementById("game");
    canvas.width = CFG.VIEW_W;
    canvas.height = CFG.VIEW_H;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    this._fitCanvas();
    window.addEventListener("resize", () => this._fitCanvas());

    UI.init();
    Input.init(canvas);
    Sprites.build();

    this._buildWorld();
    this._cacheBackground();

    const bf = this.forts.find(f => f.team === TEAM.BLUE);
    if (bf) this.centerCam(bf.x, bf.y);

    this.commander = new Commander(TEAM.RED);

    UI.showOverlay(
      "ZONE WARS",
      "A retro real-time-tactics battle in the spirit of Z. You are BLUE.\n\n" +
      "CONTROLS\n" +
      "• Left-click or drag a box to select (Shift adds, double-click picks all of a type)\n" +
      "• Right-click: MOVE / ATTACK an enemy / CAPTURE a flag — Shift queues orders\n" +
      "• A then click = ATTACK-MOVE. Right-click a friendly APC to load infantry, U unloads\n" +
      "• Ctrl+1–9 saves a control group, 1–9 recalls it (double-tap jumps the camera)\n" +
      "• Scroll with arrows, screen edges or the minimap; right-click the minimap to order\n" +
      "• H hold · S stop · Esc deselect · P pause · +/− game speed · M mute\n" +
      "• Click your factory to choose what it builds; right-click to set its rally point\n\n" +
      "Hold sectors to build faster. Tank shells and rockets now fly to a POINT — dodge them, " +
      "and don't clump: blasts hurt your own troops too. Snipers drop vehicle crews with every 3rd hit. " +
      "Win by elimination, destroying the enemy fort, or sneaking a unit inside it.",
      "START BATTLE",
      () => { Sound.init(); this.start(); }
    );

    // render one static frame behind the overlay
    this._render();
  },

  // scale the fixed-resolution canvas up to fill the stage (aspect preserved,
  // snapped to integer multiples when possible so pixels stay square)
  _fitCanvas() {
    const stage = this.canvas.parentElement;
    if (!stage) return;
    const sw = stage.clientWidth - 8, sh = stage.clientHeight - 8;
    if (sw <= 0 || sh <= 0) return;
    let s = Math.min(sw / CFG.VIEW_W, sh / CFG.VIEW_H);
    if (s >= 1) s = Math.max(1, Math.floor(s * 2) / 2);    // whole/half steps only
    this.canvas.style.width = Math.round(CFG.VIEW_W * s) + "px";
    this.canvas.style.height = Math.round(CFG.VIEW_H * s) + "px";
  },

  start() {
    if (this._looping) return;        // never stack more than one animation loop
    this._looping = true;
    this.running = true;
    this.last = performance.now();
    this._frameBound = this._frame.bind(this);
    requestAnimationFrame(this._frameBound);
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

    // scatter cacti + boulders on open sand
    for (let i = 0; i < 60; i++) {
      const tx = Util.randInt(1, CFG.COLS - 2), ty = Util.randInt(1, CFG.ROWS - 2);
      if (this.terrain[this.tkey(tx, ty)] === TERR.SAND && Util.chance(0.5))
        this.decor.push({ tx, ty, x: Util.cx(tx), y: Util.cy(ty), h: Util.randInt(4, 7), type: "cactus" });
    }
    for (let i = 0; i < 38; i++) {
      const tx = Util.randInt(1, CFG.COLS - 2), ty = Util.randInt(1, CFG.ROWS - 2);
      if (this.terrain[this.tkey(tx, ty)] === TERR.SAND && Util.chance(0.6))
        this.decor.push({ tx, ty, x: Util.cx(tx), y: Util.cy(ty), type: "rock" });
    }
    // old battle craters and collapsed ruins tell a story on the sand
    for (let i = 0; i < 16; i++) {
      const tx = Util.randInt(2, CFG.COLS - 3), ty = Util.randInt(2, CFG.ROWS - 3);
      if (this.terrain[this.tkey(tx, ty)] === TERR.SAND)
        this.decor.push({ tx, ty, x: Util.cx(tx), y: Util.cy(ty), type: "crater", r: Util.randInt(4, 8) });
    }
    for (let i = 0; i < 9; i++) {
      const tx = Util.randInt(2, CFG.COLS - 3), ty = Util.randInt(2, CFG.ROWS - 3);
      if (this.terrain[this.tkey(tx, ty)] === TERR.SAND)
        this.decor.push({ tx, ty, x: Util.cx(tx), y: Util.cy(ty), type: "ruin" });
    }
    // palm trees cluster on the shores of the lakes (oasis look)
    for (let y = 1; y < CFG.ROWS - 1; y++) for (let x = 1; x < CFG.COLS - 1; x++) {
      if (this.terrain[this.tkey(x, y)] !== TERR.SAND) continue;
      let nearWater = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
        if (this.terrain[this.tkey(x + dx, y + dy)] === TERR.WATER) nearWater = true;
      if (nearWater && Util.chance(0.3))
        this.decor.push({ tx: x, ty: y, x: Util.cx(x), y: Util.cy(y), type: "palm", h: Util.randInt(7, 10) });
    }

    // ---- irregular sector partition (organic, ~equal area) -----------
    this._buildSectors();

    // home sectors: leftmost region = blue, rightmost = red
    let blueHome = this.sectors[0], redHome = this.sectors[0];
    for (const s of this.sectors) { if (s.tx < blueHome.tx) blueHome = s; if (s.tx > redHome.tx) redHome = s; }
    blueHome.owner = TEAM.BLUE; redHome.owner = TEAM.RED;

    // flag at each region's representative interior tile
    for (const s of this.sectors) { this._clearArea(s.tx, s.ty, 1); s.flag = new Flag(s, s.cx, s.cy); }

    // ---- factories ----------------------------------------------------
    this._addFactory(blueHome, "robot", -2, -1);
    this._addFactory(blueHome, "vehicle", 2, 1);
    this._addFactory(redHome, "robot", 2, -1);
    this._addFactory(redHome, "vehicle", -2, 1);
    // most neutral regions get a factory, cycling type (varies each game)
    const kinds = ["robot", "vehicle", "gun"]; let ki = 0;
    for (const s of this.sectors) {
      if (s.owner !== TEAM.NEUTRAL) continue;
      if (Util.chance(0.8)) this._addFactory(s, kinds[ki++ % kinds.length], 0, -1);
    }

    // ---- forts (each home region, pushed toward its map edge) --------
    const bfx = Util.clamp(blueHome.tx - 3, 2, CFG.COLS - 3), bfy = Util.clamp(blueHome.ty, 3, CFG.ROWS - 4);
    const rfx = Util.clamp(redHome.tx + 3, 2, CFG.COLS - 3), rfy = Util.clamp(redHome.ty, 3, CFG.ROWS - 4);
    this._clearArea(bfx, bfy, 3); this._clearArea(rfx, rfy, 3);
    this.forts.push(new Fort(TEAM.BLUE, Util.cx(bfx), Util.cy(bfy), { x: bfx, y: bfy }));
    this.forts.push(new Fort(TEAM.RED, Util.cx(rfx), Util.cy(rfy), { x: rfx, y: rfy }));

    // ---- starting armies + a neutral tank to fight over --------------
    this._spawnSquad(TEAM.BLUE, Util.cx(bfx + 3), Util.cy(bfy), ["grunt", "grunt", "psycho", "sniper"]);
    this._spawnSquad(TEAM.RED, Util.cx(rfx - 3), Util.cy(rfy), ["grunt", "grunt", "psycho", "sniper"]);
    const mtx = Math.floor(CFG.COLS / 2), mty = Math.floor(CFG.ROWS / 2);
    this._clearArea(mtx, mty, 1);
    this.units.push(new Unit("machine", "light", null, Util.cx(mtx), Util.cy(mty)));

    // ---- road network following the partition + a few sandbags -------
    this._carveRoads();
    this._placeSandbags();
  },

  /* Partition the whole tile grid into organic, roughly equal-area regions by
   * balanced simultaneous growth from jittered seeds — fair division, varied
   * shapes, borders aligned to the pixel/tile grid, different every game. */
  _buildSectors() {
    const COLS = CFG.COLS, ROWS = CFG.ROWS, TOTAL = COLS * ROWS;
    const gc = 4, gr = 3, K = gc * gr;                 // 12 regions, jittered grid of seeds
    const seeds = [];
    for (let r = 0; r < gr; r++) for (let c = 0; c < gc; c++) {
      const x0 = c * COLS / gc, x1 = (c + 1) * COLS / gc, y0 = r * ROWS / gr, y1 = (r + 1) * ROWS / gr;
      const sx = Util.clamp(Math.round(x0 + Util.rand(0.28, 0.72) * (x1 - x0)), 1, COLS - 2);
      const sy = Util.clamp(Math.round(y0 + Util.rand(0.28, 0.72) * (y1 - y0)), 1, ROWS - 2);
      seeds.push({ x: sx, y: sy });
    }
    const region = new Int16Array(TOTAL).fill(-1);
    const frontier = seeds.map(() => []);
    seeds.forEach((s, i) => { const k = s.y * COLS + s.x; region[k] = i; frontier[i].push(k); });
    let remaining = TOTAL - K;
    const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const order = Array.from({ length: K }, (_, i) => i);
    while (remaining > 0) {
      for (let i = order.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [order[i], order[j]] = [order[j], order[i]]; }
      let progressed = false;
      for (const i of order) {                          // each region claims ONE tile -> equal areas
        const fr = frontier[i];
        let claimed = false;
        while (fr.length && !claimed) {
          const k = fr[0], x = k % COLS, y = (k / COLS) | 0;
          const nb = NB.slice();
          for (let a = nb.length - 1; a > 0; a--) { const b = (Math.random() * (a + 1)) | 0; [nb[a], nb[b]] = [nb[b], nb[a]]; }
          let took = false;
          for (const [dx, dy] of nb) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
            const nk = ny * COLS + nx;
            if (region[nk] === -1) { region[nk] = i; fr.push(nk); remaining--; claimed = progressed = took = true; break; }
          }
          if (!took) fr.shift();                         // interior tile — retire it
        }
      }
      if (!progressed) break;
    }
    for (let k = 0; k < TOTAL; k++) if (region[k] === -1) {   // assign stragglers
      const x = k % COLS, y = (k / COLS) | 0;
      for (const [dx, dy] of NB) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue; const nk = ny * COLS + nx; if (region[nk] >= 0) { region[k] = region[nk]; break; } }
      if (region[k] === -1) region[k] = 0;
    }
    this.sectorOf = region;

    // Sector objects: tile count, representative interior tile, fill runs
    this.sectors = Array.from({ length: K }, (_, i) => new Sector(i));
    const sumX = new Float64Array(K), sumY = new Float64Array(K), cnt = new Int32Array(K);
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) { const i = region[y * COLS + x]; sumX[i] += x; sumY[i] += y; cnt[i]++; }
    const fcx = new Float64Array(K), fcy = new Float64Array(K), bestD = new Float64Array(K).fill(Infinity);
    for (let i = 0; i < K; i++) { fcx[i] = sumX[i] / cnt[i]; fcy[i] = sumY[i] / cnt[i]; this.sectors[i].tileCount = cnt[i]; }
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const i = region[y * COLS + x], d = (x - fcx[i]) ** 2 + (y - fcy[i]) ** 2;
      if (d < bestD[i]) { bestD[i] = d; this.sectors[i].tx = x; this.sectors[i].ty = y; }
    }
    for (const s of this.sectors) { s.cx = Util.cx(s.tx); s.cy = Util.cy(s.ty); }
    for (let y = 0; y < ROWS; y++) { let x = 0; while (x < COLS) { const i = region[y * COLS + x]; let x1 = x; while (x1 + 1 < COLS && region[y * COLS + x1 + 1] === i) x1++; this.sectors[i].runs.push({ y, x0: x, x1 }); x = x1 + 1; } }
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

  // L-shaped road between two representative tiles
  _linkRoad(ax, ay, bx, by) {
    for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) this._road(x, ay);
    for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) this._road(bx, y);
  },

  // Road network that follows the partition: connect every pair of adjacent
  // regions through their centres, then link each fort to its home flag.
  _carveRoads() {
    const COLS = CFG.COLS, ROWS = CFG.ROWS, seen = new Set();
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const i = this.sectorOf[y * COLS + x];
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = x + dx, ny = y + dy; if (nx >= COLS || ny >= ROWS) continue;
        const j = this.sectorOf[ny * COLS + nx];
        if (j === i) continue;
        const key = i < j ? i * 100 + j : j * 100 + i;
        if (seen.has(key)) continue; seen.add(key);
        const a = this.sectors[i], b = this.sectors[j];
        this._linkRoad(a.tx, a.ty, b.tx, b.ty);
      }
    }
    for (const f of this.forts) {
      const s = Sectors.sectorAt(f.x, f.y);
      if (s) this._linkRoad(Util.tx(f.x), Util.ty(f.y), s.tx, s.ty);
    }
  },

  _placeSandbags() {
    // a few short destructible sandbag walls so boxed-in units demonstrate
    // shooting through walls; placed on open sand around the map middle.
    const cx = Math.floor(CFG.COLS / 2);
    for (let i = 0; i < 4; i++) {
      const bx = Util.clamp(cx + Util.randInt(-12, 12), 2, CFG.COLS - 3);
      const by = Util.randInt(5, CFG.ROWS - 6), len = Util.randInt(3, 6);
      for (let d = 0; d < len; d++) {
        const x = bx, y = by + d;
        if (this._inBounds(x, y) && this.terrain[this.tkey(x, y)] === TERR.SAND) {
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
    const fx = Util.clamp(sector.tx + dx, 1, CFG.COLS - 2);
    const fy = Util.clamp(sector.ty + dy, 1, CFG.ROWS - 2);
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
    if (this.paused) {
      this._updateCamera(dt);       // the camera still pans while paused
      this.dt = 0;
    } else {
      this.dt = dt * this.speedMult;
      this._update(this.dt, dt);
    }
    this._render();
    requestAnimationFrame(this._frameBound);
  },

  _updateCamera(dt) {
    const sp = 520 * dt, k = Input.keys;
    // edge-scroll direction persists even after the cursor leaves the canvas
    let dx = Input.edge.dx, dy = Input.edge.dy;
    if (k.has("arrowleft")) dx -= 1;
    if (k.has("arrowright")) dx += 1;
    if (k.has("arrowup")) dy -= 1;
    if (k.has("arrowdown")) dy += 1;
    dx = Util.clamp(dx, -1, 1); dy = Util.clamp(dy, -1, 1);
    if (dx || dy) { this.cam.x += dx * sp; this.cam.y += dy * sp; this.clampCam(); }
  },

  _update(dt, rawDt) {
    if (this.over) return;
    this.dt = dt;
    this.time += dt;
    this._updateCamera(rawDt ?? dt);   // camera speed is independent of game speed

    // per-frame population count (used for the production cap — O(1) lookups)
    this._pop = { blue: 0, red: 0 };
    for (const u of this.units) if (u.alive && u.crewed) this._pop[u.team]++;

    // passive mana regen for both HQs (capped)
    this.mana.blue = Math.min(CFG.MANA_MAX, this.mana.blue + CFG.MANA_REGEN * dt);
    this.mana.red = Math.min(CFG.MANA_MAX, this.mana.red + CFG.MANA_REGEN * dt);

    this.commander.update(dt);

    for (const u of this.units) UnitAI.think(u);
    for (const u of this.units) u.update(dt);
    this._separate(dt);
    for (const f of this.factories) f.update(dt);
    for (const f of this.forts) f.update(dt);

    for (const p of this.projectiles) p.update(dt);
    for (const e of this.fx) e.update(dt);
    for (const s of this.scorch) s.t += dt;
    for (const s of this.tracks) s.t += dt;
    for (const c of this.corpses) c.t += dt;

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
          Sound.playAt("crew", m.x, m.y);
          break;
        }
      }
    }
  },

  // soft collision: overlapping mobile units push each other apart so armies
  // spread out instead of stacking on one tile. Vehicles still drive INTO
  // enemy infantry (that's how crushing works), so those pairs are skipped.
  _separate(dt) {
    const us = this.units, n = us.length;
    const push = CFG.SEPARATION_PUSH * dt;
    for (let i = 0; i < n; i++) {
      const a = us[i];
      if (!a.alive || (a.kind === "machine" && (a.immobile || !a.driver))) continue;
      for (let j = i + 1; j < n; j++) {
        const b = us[j];
        if (!b.alive || (b.kind === "machine" && (b.immobile || !b.driver))) continue;
        // let crushers reach their victims
        if (a.team !== b.team &&
            ((a.isVehicle() && b.kind === "infantry") || (b.isVehicle() && a.kind === "infantry"))) continue;
        const minD = a.radius + b.radius - 2;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minD * minD || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const f = Math.min(push, (minD - d) * 0.5) / (d || 1);
        const ox = dx * f, oy = dy * f;
        if (this.tilePassable(Util.tx(a.x - ox), Util.ty(a.y - oy))) { a.x -= ox; a.y -= oy; }
        if (this.tilePassable(Util.tx(b.x + ox), Util.ty(b.y + oy))) { b.x += ox; b.y += oy; }
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
    this.tracks = this.tracks.filter(s => s.t < s.life);
    this.corpses = this.corpses.filter(c => c.t < c.life);
    this.pings = this.pings.filter(p => this.time - p.born < 3);
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
    bg.width = this.worldW(); bg.height = this.worldH();
    const c = bg.getContext("2d"); c.imageSmoothingEnabled = false;
    const T = CFG.TILE, K = CFG.COLORS;
    const at = (x, y) => (this._inBounds(x, y) ? this.terrain[this.tkey(x, y)] : TERR.SAND);
    const H = (a, b) => Util.hash(a, b);
    const isLand = (x, y) => { const tt = at(x, y); return tt !== TERR.WATER && tt !== TERR.BRIDGE; };

    for (let y = 0; y < CFG.ROWS; y++) {
      for (let x = 0; x < CFG.COLS; x++) {
        const t = this.terrain[this.tkey(x, y)];
        const X = x * T, Y = y * T;
        const r1 = H(x, y), r2 = H(x * 3 + 7, y * 5 + 1), r3 = H(x * 13, y * 7 + 3);

        if (t === TERR.CLIFF) {
          this._tileCliff(c, x, y, X, Y, T, K, at, H);
          continue;
        }
        if (t === TERR.WATER) { this._tileWater(c, x, y, X, Y, T, K, isLand, H); continue; }
        if (t === TERR.BRIDGE) { this._tileBridge(c, X, Y, T, K); continue; }

        // ---- sandy ground base (sand / scrub / road all sit on it) ----
        // large-scale dune banding for structure across many tiles
        const dune = H(Math.floor(x / 5) + 1, Math.floor(y / 4));
        let base = ((x + y) & 1) ? K.sand : K.sand2;
        if (dune > 0.72) base = K.speck; else if (dune < 0.26) base = K.sand3;
        c.fillStyle = base; c.fillRect(X, Y, T, T);
        // grain speckle
        if (r1 > 0.55) { c.fillStyle = K.speck; c.fillRect(X + Math.floor(r1 * 90) % (T - 1), Y + Math.floor(r2 * 70) % (T - 1), 1, 1); }
        if (r2 > 0.78) { c.fillStyle = K.sand3; c.fillRect(X + Math.floor(r2 * 50) % (T - 2), Y + Math.floor(r3 * 40) % (T - 2), 2, 1); }
        // small embedded pebble with shadow
        if (r3 < 0.10) {
          const px = X + 3 + Math.floor(r1 * 7), py = Y + 4 + Math.floor(r2 * 6);
          c.fillStyle = "rgba(0,0,0,0.18)"; c.fillRect(px, py + 2, 3, 1);
          c.fillStyle = "#9a7b48"; c.fillRect(px, py, 3, 2); c.fillStyle = "#b89a5e"; c.fillRect(px, py, 1, 1);
        }

        if (t === TERR.SCRUB) {
          c.fillStyle = "rgba(0,0,0,0.10)"; c.fillRect(X, Y, T, T);
          for (let i = 0; i < 7; i++) {
            const hx = H(x * 9 + i, y), hy = H(x, y * 9 + i);
            c.fillStyle = hy > 0.5 ? K.scrub : K.cactus;
            c.fillRect(X + Math.floor(hx * (T - 2)), Y + Math.floor(hy * (T - 2)), 2, hy > 0.7 ? 2 : 1);
          }
        } else if (t === TERR.ROAD) {
          c.fillStyle = K.road; c.fillRect(X, Y, T, T);
          // worn, dithered asphalt + cracks
          for (let i = 0; i < 5; i++) { const hx = H(x * 4 + i, y * 6), hy = H(x * 6, y * 4 + i); c.fillStyle = hx > 0.5 ? K.roadLo : "#a8a294"; c.fillRect(X + Math.floor(hx * (T - 1)), Y + Math.floor(hy * (T - 1)), 1, 1); }
          c.fillStyle = K.roadLo; c.fillRect(X, Y, T, 2); c.fillRect(X, Y + T - 2, T, 2);
          if (r1 > 0.8) { c.fillStyle = "#6f695b"; c.fillRect(X + Math.floor(r2 * (T - 2)), Y + 2, 1, T - 4); } // crack
          // worn edge where road meets sand
          if (isLand(x, y - 1) && at(x, y - 1) !== TERR.ROAD) { c.fillStyle = K.sand2; for (let i = 0; i < T; i += 3) if (H(x + i, y) > 0.5) c.fillRect(X + i, Y, 2, 1); }
          if (at(x - 1, y) === TERR.ROAD && at(x + 1, y) === TERR.ROAD && (x & 1)) { c.fillStyle = K.roadLine; c.fillRect(X + 4, Y + T / 2 - 1, T - 8, 2); }
        }

        // cast shadow from neighbouring cliffs (depth)
        if (at(x, y - 1) === TERR.CLIFF) { c.fillStyle = "rgba(0,0,0,0.20)"; c.fillRect(X, Y, T, 4); }
        if (at(x - 1, y) === TERR.CLIFF) { c.fillStyle = "rgba(0,0,0,0.13)"; c.fillRect(X, Y, 4, T); }
      }
    }

    for (const d of this.decor) this._decor(c, d, K);

    // sector borders baked over the terrain: a solid carved line with a
    // dotted bright highlight (reads through the per-frame ownership tint)
    for (let y = 0; y < CFG.ROWS; y++) for (let x = 0; x < CFG.COLS; x++) {
      const i = this.sectorOf[this.tkey(x, y)], X = x * T, Y = y * T;
      if (x + 1 < CFG.COLS && this.sectorOf[this.tkey(x + 1, y)] !== i) {
        c.fillStyle = "rgba(0,0,0,0.55)"; c.fillRect(X + T - 1, Y, 1, T);
        c.fillStyle = "rgba(255,236,190,0.45)"; for (let yy = 0; yy < T; yy += 3) c.fillRect(X + T - 2, Y + yy, 1, 1);
      }
      if (y + 1 < CFG.ROWS && this.sectorOf[this.tkey(x, y + 1)] !== i) {
        c.fillStyle = "rgba(0,0,0,0.55)"; c.fillRect(X, Y + T - 1, T, 1);
        c.fillStyle = "rgba(255,236,190,0.45)"; for (let xx = 0; xx < T; xx += 3) c.fillRect(X + xx, Y + T - 2, 1, 1);
      }
    }
    this.bg = bg;
  },

  _tileCliff(c, x, y, X, Y, T, K, at, H) {
    const CL = TERR.CLIFF;
    c.fillStyle = K.cliff; c.fillRect(X, Y, T, T);
    // rocky dither texture
    for (let i = 0; i < 4; i++) { const hx = H(x * 7 + i, y * 5), hy = H(x * 5, y * 7 + i); c.fillStyle = hx > 0.5 ? K.cliffHi : K.cliffLo; c.fillRect(X + Math.floor(hx * (T - 3)), Y + Math.floor(hy * (T - 3)), 2, 2); }
    // horizontal strata
    c.fillStyle = K.cliffLo; c.fillRect(X, Y + 5, T, 1); c.fillRect(X, Y + 11, T, 1);
    c.fillStyle = K.cliffHi; c.fillRect(X, Y + 4, T, 1);
    // sunlit top / shadowed faces depending on neighbours
    if (at(x, y - 1) !== CL) { c.fillStyle = K.cliffHi; c.fillRect(X, Y, T, 3); c.fillStyle = "#c2a060"; c.fillRect(X, Y, T, 1); }
    if (at(x, y + 1) !== CL) { c.fillStyle = K.cliffLo; c.fillRect(X, Y + T - 4, T, 4); c.fillStyle = "rgba(0,0,0,0.25)"; c.fillRect(X, Y + T - 1, T, 1); }
    if (at(x + 1, y) !== CL) { c.fillStyle = K.cliffLo; c.fillRect(X + T - 3, Y, 3, T); }
    if (at(x - 1, y) !== CL) { c.fillStyle = K.cliffHi; c.fillRect(X, Y, 2, T); }
    if (H(x, y) > 0.7) { c.fillStyle = K.cliffLo; c.fillRect(X + 3 + Math.floor(H(x, y) * 8), Y + 2, 1, T - 4); } // crack
  },

  _tileWater(c, x, y, X, Y, T, K, isLand, H) {
    c.fillStyle = K.water; c.fillRect(X, Y, T, T);
    // wave dither + deeper band
    for (let i = 0; i < 4; i++) { const hx = H(x * 6 + i, y * 3), hy = H(x * 3, y * 6 + i); c.fillStyle = hx > 0.55 ? K.water2 : K.waterHi; c.fillRect(X + Math.floor(hx * (T - 3)), Y + Math.floor(hy * (T - 1)), 3, 1); }
    c.fillStyle = K.water2; c.fillRect(X, Y + T - 4, T, 4);
    // foam at the shoreline
    if (isLand(x, y - 1)) { c.fillStyle = "#cfe6ee"; c.fillRect(X, Y, T, 2); }
    if (isLand(x, y + 1)) { c.fillStyle = "#a6d2e0"; c.fillRect(X, Y + T - 2, T, 2); }
    if (isLand(x - 1, y)) { c.fillStyle = "#cfe6ee"; c.fillRect(X, Y, 2, T); }
    if (isLand(x + 1, y)) { c.fillStyle = "#a6d2e0"; c.fillRect(X + T - 2, Y, 2, T); }
  },

  _tileBridge(c, X, Y, T, K) {
    c.fillStyle = K.water; c.fillRect(X, Y, T, T);
    c.fillStyle = K.bridge; c.fillRect(X, Y + 1, T, T - 2);
    c.fillStyle = K.bridgeLo; for (let p = 0; p < T; p += 4) c.fillRect(X + p, Y + 1, 1, T - 2);  // planks
    c.fillStyle = "#8a6a3c"; c.fillRect(X, Y + 1, T, 1);                                          // rail
    c.fillStyle = "#3a2c18"; c.fillRect(X, Y + T - 2, T, 1);
    c.fillStyle = "#2a2018"; c.fillRect(X + 1, Y + 2, 1, 1); c.fillRect(X + T - 2, Y + 2, 1, 1);  // bolts
  },

  _decor(c, d, K) {
    const X = d.x, Y = d.y;
    if (d.type === "crater") {                     // old shell crater
      PX.fillOval(c, X, Y, d.r + 2, (d.r + 2) * 0.7, "#a8854c", 1);   // thrown-out rim
      PX.fillOval(c, X, Y, d.r, d.r * 0.65, "#6f5630", 1);
      PX.fillOval(c, X + 1, Y + 1, d.r - 2, (d.r - 2) * 0.6, "#54431f", 1);
      c.fillStyle = "#d8b97e"; c.fillRect(X - d.r, Y - Math.round(d.r * 0.7), d.r, 1); // sunlit rim
      return;
    }
    if (d.type === "ruin") {                       // collapsed wall stub
      c.fillStyle = "rgba(0,0,0,0.2)"; c.fillRect(X - 6, Y + 4, 14, 2);
      c.fillStyle = "#8a8478"; c.fillRect(X - 6, Y - 4, 5, 9);        // standing corner
      c.fillStyle = "#9a948a"; c.fillRect(X - 6, Y - 4, 5, 2);
      c.fillStyle = "#6f6a60"; c.fillRect(X - 6, Y + 3, 5, 2);
      for (let i = 0; i < 7; i++) {                                    // tumbled blocks
        const hx = Util.hash(d.tx * 5 + i, d.ty), hy = Util.hash(d.tx, d.ty * 5 + i);
        c.fillStyle = hx > 0.5 ? "#85806f" : "#736e5f";
        c.fillRect(X - 2 + Math.floor(hx * 10), Y - 2 + Math.floor(hy * 8), 3, 2);
      }
      return;
    }
    if (d.type === "palm") {                       // oasis palm
      c.fillStyle = "rgba(0,0,0,0.25)"; c.fillRect(X - 3, Y + 2, 9, 2);
      c.fillStyle = "#6b4a26";                                         // curved trunk
      for (let i = 0; i < d.h; i++) c.fillRect(X + Math.round(i * 0.25), Y - i, 2, 1);
      const tx2 = X + Math.round(d.h * 0.25), ty2 = Y - d.h;
      for (const [fx, fy] of [[-5, -2], [5, -2], [-4, 2], [4, 2], [0, -4], [-6, 0], [6, 0]]) {
        PX.line(c, tx2, ty2, tx2 + fx, ty2 + fy, "#3f7a3a", 1, 1);     // fronds
      }
      c.fillStyle = "#5aa552"; c.fillRect(tx2 - 1, ty2 - 1, 3, 2);
      return;
    }
    if (d.type === "rock") {                       // boulder cluster
      c.fillStyle = "rgba(0,0,0,0.22)"; c.fillRect(X - 3, Y + 2, 10, 3);
      c.fillStyle = "#6b6457"; c.fillRect(X - 3, Y - 2, 8, 6);
      c.fillStyle = "#7d7567"; c.fillRect(X - 2, Y - 3, 5, 4);
      c.fillStyle = "#565045"; c.fillRect(X + 1, Y + 1, 4, 3);
      c.fillStyle = "#8e8676"; c.fillRect(X - 2, Y - 3, 2, 2);
      c.fillStyle = "#6b6457"; c.fillRect(X + 4, Y, 4, 4); c.fillStyle = "#565045"; c.fillRect(X + 5, Y + 2, 3, 2);
    } else {                                        // cactus
      c.fillStyle = "rgba(0,0,0,0.25)"; c.fillRect(X - 2, Y + 3, 6, 2);
      c.fillStyle = K.cactus; c.fillRect(X - 1, Y - d.h, 3, d.h + 3);
      c.fillRect(X - 4, Y - d.h + 2, 3, 2); c.fillRect(X - 4, Y - d.h + 2, 2, 5);
      c.fillRect(X + 2, Y - d.h + 4, 3, 2); c.fillRect(X + 3, Y - d.h, 2, 6);
      c.fillStyle = K.cactusHi; c.fillRect(X - 1, Y - d.h, 1, d.h);
    }
  },

  // is a world point within (a margin of) the visible viewport?
  _inView(x, y, m = 52) {
    return x > this.cam.x - m && x < this.cam.x + CFG.VIEW_W + m
        && y > this.cam.y - m && y < this.cam.y + CFG.VIEW_H + m;
  },

  _render() {
    const ctx = this.ctx, T = CFG.TILE;
    const cx = Math.round(this.cam.x), cy = Math.round(this.cam.y);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // ---- world pass: only the visible slice is drawn ----
    ctx.save();
    ctx.translate(-cx, -cy);
    ctx.drawImage(this.bg, cx, cy, CFG.VIEW_W, CFG.VIEW_H, cx, cy, CFG.VIEW_W, CFG.VIEW_H);

    const vx0 = cx - T, vx1 = cx + CFG.VIEW_W, vy0 = cy - T, vy1 = cy + CFG.VIEW_H;
    // sector ownership tint over the irregular regions (visible runs only)
    const fillRuns = (s, style) => {
      ctx.fillStyle = style;
      for (const r of s.runs) {
        const ry = r.y * T; if (ry > vy1 || ry + T < vy0) continue;
        const rx = r.x0 * T, rw = (r.x1 - r.x0 + 1) * T; if (rx > vx1 || rx + rw < vx0) continue;
        ctx.fillRect(rx, ry, rw, T);
      }
    };
    for (const s of this.sectors) {
      const col = s.owner === TEAM.BLUE ? "77,166,255" : s.owner === TEAM.RED ? "255,91,91" : "150,150,150";
      fillRuns(s, `rgba(${col},${s.owner === TEAM.NEUTRAL ? 0.05 : 0.12})`);
      if (s.capProgress > 0 && s.capTeam) {
        const cc = s.contested ? "255,255,255" : s.capTeam === TEAM.BLUE ? "77,166,255" : "255,91,91";
        fillRuns(s, `rgba(${cc},${0.05 + 0.18 * s.capProgress})`);
      }
      if (s.flash > 0) fillRuns(s, `rgba(${col},${0.25 * s.flash})`);
    }

    // destructible sandbag walls (visible only)
    for (const [k, hp] of this.walls) {
      const x = (k % CFG.COLS) * T, y = Math.floor(k / CFG.COLS) * T;
      if (x > vx1 || x + T < vx0 || y > vy1 || y + T < vy0) continue;
      const dmg = Util.clamp(hp / 60, 0, 1);
      ctx.fillStyle = "rgba(0,0,0,0.2)"; ctx.fillRect(x + 2, y + T - 3, T - 2, 3);
      for (let r = 0; r < 3; r++) for (let cc = 0; cc < 3; cc++) {
        if ((r * 3 + cc) / 9 > dmg) continue;
        ctx.fillStyle = (r + cc) & 1 ? CFG.COLORS.wall : CFG.COLORS.wallLo;
        ctx.fillRect(x + cc * 5 + 1, y + r * 5 + 1, 5, 5);
        ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(x + cc * 5 + 1, y + r * 5 + 4, 5, 1);
      }
    }

    this._drawTracks(ctx);
    this._drawScorch(ctx);
    this._drawCorpses(ctx);
    this._drawFlags(ctx);
    this._drawFactories(ctx);
    this._drawForts(ctx);
    this._drawProjectiles(ctx);
    this._drawUnits(ctx);
    this._drawOrders(ctx);       // faint lines from selected units to their goal
    this._drawFx(ctx);           // fire/debris/smoke render on top of units
    ctx.restore();
    // ---- screen-space HUD (not affected by the camera) ----
    Input.popupRects.length = 0;
    this._drawSelectionBox(ctx);
    this._drawSelectionPanel(ctx); // bottom-left: what's selected
    this._drawFactoryPopup(ctx); // unit-select popup above the selected factory
    this._drawFortPopup(ctx);    // HQ command popup (train / instant / upgrades)
    this._drawMinimap(ctx);
    this._drawSpeedState(ctx);   // PAUSED / fast-forward banner
    this._drawCursor(ctx);       // context-sensitive cursor, drawn last
  },

  // fading tread marks: two short bars perpendicular to the hull direction
  _drawTracks(ctx) {
    for (const s of this.tracks) {
      if (!this._inView(s.x, s.y)) continue;
      const a = 0.16 * (1 - s.t / s.life);
      const px = -Math.sin(s.ang) * s.spread, py = Math.cos(s.ang) * s.spread;
      ctx.fillStyle = `rgba(60,44,24,${a})`;
      ctx.fillRect(Math.round(s.x + px) - 1, Math.round(s.y + py) - 1, 3, 3);
      ctx.fillRect(Math.round(s.x - px) - 1, Math.round(s.y - py) - 1, 3, 3);
    }
  },

  // fallen infantry stay on the field and slowly fade
  _drawCorpses(ctx) {
    for (const c of this.corpses) {
      if (!this._inView(c.x, c.y)) continue;
      const p = c.t / c.life;
      const a = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
      PX.fillOval(ctx, c.x, c.y + 2, 6, 3.5, `rgba(102,16,16,${0.45 * a})`, 2);  // blood pool
      const palTeam = c.team === TEAM.BLUE ? "blue" : "red";
      const img = Sprites.infantry(c.typeKey, palTeam, (c.dir + 2) % 8, 0);  // sideways = fallen
      ctx.globalAlpha = 0.75 * a;
      this._blit(ctx, img, c.x, c.y, CFG.UNIT_SCALE);
      ctx.globalAlpha = 1;
    }
  },

  // top-centre banner for pause / game speed
  _drawSpeedState(ctx) {
    if (!this.paused && this.speedMult === 1) return;
    const label = this.paused ? "PAUSED — P to resume" : `SPEED ×${this.speedMult}`;
    ctx.font = "bold 12px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const w = label.length * 7 + 18;
    ctx.fillStyle = "rgba(8,10,12,0.85)"; ctx.fillRect(CFG.VIEW_W / 2 - w / 2, 8, w, 20);
    ctx.fillStyle = this.paused ? "#ffe24a" : "#9cff6a";
    ctx.fillText(label, CFG.VIEW_W / 2, 18);
    ctx.textAlign = "left";
  },

  _cmdColor(kind) {
    return { move: "#9cff6a", amove: "#ffb24a", attack: "#ff5b5b", capture: "#ffe24a", rally: "#4da6ff" }[kind] || "#ffffff";
  },

  // tiny pixel pictogram centred on (x,y)
  _cmdIcon(ctx, kind, x, y, col) {
    ctx.fillStyle = col;
    if (kind === "attack") {                         // X
      for (let i = -3; i <= 3; i++) { ctx.fillRect(x + i, y + i, 2, 2); ctx.fillRect(x + i, y - i, 2, 2); }
    } else if (kind === "capture") {                 // little flag
      ctx.fillRect(x - 1, y - 5, 2, 10); ctx.fillStyle = col;
      ctx.fillRect(x + 1, y - 5, 6, 2); ctx.fillRect(x + 1, y - 3, 4, 2);
    } else if (kind === "move" || kind === "amove") { // down chevron(s)
      ctx.fillRect(x - 3, y - 2, 6, 2); ctx.fillRect(x - 1, y, 2, 2);
    } else if (kind === "rally") {
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  },

  _drawOrders(ctx) {
    for (const u of this.units) {
      if (!u.selected || !u.alive || !this._inView(u.x, u.y, 600)) continue;
      if (u.commandAttack && u.commandAttack.alive) {
        PX.line(ctx, u.x, u.y, u.commandAttack.x, u.commandAttack.y, "rgba(255,91,91,0.35)", 2, 2);
      } else if (u.moveGoalX != null) {
        const col = u.attackMove ? "rgba(255,178,74,0.35)" : "rgba(156,255,106,0.30)";
        PX.line(ctx, u.x, u.y, u.moveGoalX, u.moveGoalY, col, 2, 2);
      }
    }
  },

  _drawCursor(ctx) {
    const m = Input.mouse, kind = Input.attackMoveArmed ? "amove" : Input.hover.kind;
    const col = kind === "attack" ? "#ff5b5b" : kind === "capture" ? "#ffe24a"
              : kind === "amove" ? "#ffb24a" : kind === "rally" ? "#4da6ff"
              : kind === "board" ? "#8fd0ff"
              : kind === "select" ? "#9cff6a" : kind === "none" ? "#cccccc" : "#9cff6a";
    // crosshair
    ctx.fillStyle = col;
    ctx.fillRect(m.x - 8, m.y - 1, 5, 2); ctx.fillRect(m.x + 4, m.y - 1, 5, 2);
    ctx.fillRect(m.x - 1, m.y - 8, 2, 5); ctx.fillRect(m.x - 1, m.y + 4, 2, 5);
    if (kind === "attack") PX.ring(ctx, m.x, m.y, 6, col, 2, 2, 1);
    else if (kind === "capture") { ctx.fillRect(m.x + 2, m.y - 9, 7, 2); ctx.fillRect(m.x + 2, m.y - 7, 5, 2); ctx.fillRect(m.x + 1, m.y - 9, 2, 7); }
    else if (kind === "select") PX.brackets(ctx, m.x, m.y, 7, col, 4, 2);
    // label
    const label = { attack: "ATTACK", capture: "CAPTURE", move: "MOVE", amove: "ATK-MOVE", rally: "RALLY", select: "SELECT", board: "BOARD", none: "" }[kind];
    if (label) {
      ctx.font = "8px monospace"; ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(m.x + 9, m.y + 8, label.length * 5 + 4, 11);
      ctx.fillStyle = col; ctx.fillText(label, m.x + 11, m.y + 10);
    }
  },

  _drawScorch(ctx) {
    for (const s of this.scorch) {
      if (!this._inView(s.x, s.y)) continue;
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
      const f = s.flag; if (!f || !this._inView(f.x, f.y)) continue;
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
    for (const f of this.factories) {
      if (!this._inView(f.x, f.y, 60)) continue;
      const palTeam = f.team === TEAM.BLUE ? "blue" : f.team === TEAM.RED ? "red" : "neutral";
      const img = Sprites.building(f.ftype, palTeam);
      const bx = Math.round(f.x - img.width / 2), by = Math.round(f.y - img.height / 2 - 4);
      ctx.drawImage(img, bx, by);

      const cxc = f.x, cyc = f.y - 4;          // sprite centre (matches the -4 anchor)
      const owned = f.team !== TEAM.NEUTRAL;
      const producing = owned;
      const blink = (Math.floor(this.time * 3) % 2) === 0;

      if (owned) {
        if (f.ftype === "robot") {
          ctx.fillStyle = blink ? "#ff5b5b" : "#5a1414";            // antenna beacon
          ctx.fillRect(cxc + 13, cyc - 31, 2, 2);
        } else if (f.ftype === "vehicle") {
          // status-light stack on the front face (green run / amber / red)
          const lights = [["#7dff5b", producing && blink], ["#ffd24a", producing && !blink], ["#ff5b5b", !producing]];
          for (let i = 0; i < 3; i++) { ctx.fillStyle = lights[i][1] ? lights[i][0] : "#1a1a1a"; ctx.fillRect(cxc + 16, cyc + 1 + i * 3, 2, 2); }
          // chimney smoke while producing
          for (let i = 0; i < 3; i++) {
            const t = (this.time * 0.8 + i * 0.34) % 1;
            PX.fillCircle(ctx, cxc - 18, cyc - 33 - t * 18, 2 + t * 4, `rgba(70,64,58,${0.30 * (1 - t)})`, 2);
          }
        } else { // gun: rooftop hatch beacon
          ctx.fillStyle = blink ? "#ffd24a" : "#5a4a14";
          ctx.fillRect(cxc - 1, cyc - 9, 2, 2);
        }
      }

      // green digital countdown (like Z) + thin progress bar + hp bar
      if (owned) {
        const base = f.spec.table[f.queueKey].baseTime;
        const remain = Math.max(0, this.actualBuildTime(base, f.team) - f.progress);
        const txt = Util.fmtTime(remain);
        let tw = 0; for (const ch of txt) tw += (PXFONT[ch] || PXFONT[" "])[0].length + 1; tw -= 1;
        ctx.fillStyle = "#0a120a"; ctx.fillRect(cxc - tw / 2 - 1, cyc + 13, tw + 2, 7);
        ctx.fillStyle = "#1d381d"; ctx.fillRect(cxc - tw / 2 - 1, cyc + 13, tw + 2, 1);
        this._drawDigits(ctx, Math.round(cxc - tw / 2), cyc + 14, txt, blink ? "#86ff84" : "#56d65a");
        const w = img.width - 22, frac = f.buildFraction();
        ctx.fillStyle = "#000"; ctx.fillRect(cxc - w / 2, cyc + 21, w, 2);
        ctx.fillStyle = this._teamColor(f.team); ctx.fillRect(cxc - w / 2, cyc + 21, w * frac, 2);
      }
      if (f.hp < f.maxHp) this._bar(ctx, cxc, cyc - 34, img.width - 22, f.hp / f.maxHp, "#7d7");
    }
  },

  _drawForts(ctx) {
    for (const f of this.forts) {
      if (!this._inView(f.x, f.y, f.w)) continue;
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

      // HQ training countdown (green, like the factories) + thin bar
      const remain = Math.max(0, G.actualBuildTime(G.baseTimeOf(f.trainKey), f.team) - f.trainProgress);
      const txt = Util.fmtTime(remain);
      let tw = 0; for (const ch of txt) tw += (PXFONT[ch] || PXFONT[" "])[0].length + 1; tw -= 1;
      const ry = y + H + 2;
      ctx.fillStyle = "#0a120a"; ctx.fillRect(f.x - tw / 2 - 1, ry, tw + 2, 7);
      this._drawDigits(ctx, Math.round(f.x - tw / 2), ry + 1, txt, "#56d65a");
      ctx.fillStyle = "#000"; ctx.fillRect(f.x - W / 2, ry + 8, W, 2);
      ctx.fillStyle = main; ctx.fillRect(f.x - W / 2, ry + 8, W * f.trainFraction(), 2);
    }
  },

  _dirOf(ang) { return ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8; },

  _blit(ctx, img, x, y, scale = 1) {
    if (!img) return;
    const w = img.width * scale, h = img.height * scale;
    ctx.drawImage(img, Math.round(x - w / 2), Math.round(y - h / 2), Math.round(w), Math.round(h));
  },

  _drawUnits(ctx) {
    for (const u of this.units) {
      if (!this._inView(u.x, u.y)) continue;
      const palTeam = u.team === TEAM.BLUE ? "blue" : u.team === TEAM.RED ? "red" : "neutral";

      // soft shadow (pixel oval)
      PX.fillOval(ctx, u.x, u.y + u.radius * 0.55, u.radius * 0.95, u.radius * 0.5, "rgba(0,0,0,0.28)", 2);

      const S = CFG.UNIT_SCALE;
      if (u.kind === "machine") {
        const aim = this._dirOf(u.target ? u.facing : u.hullFacing);
        // visual recoil: the turret kicks back along the aim direction
        const kick = u.recoil > 0 ? u.recoil / 0.12 * 2.5 : 0;
        const rx = -Math.cos(u.facing) * kick, ry = -Math.sin(u.facing) * kick;
        if (u.immobile) {
          this._blit(ctx, Sprites.gunBase(palTeam), u.x, u.y, S);
          this._blit(ctx, Sprites.gunTurret(palTeam, aim), u.x + rx, u.y + ry, S);
        } else {
          this._blit(ctx, Sprites.hull(u.typeKey, palTeam, this._dirOf(u.hullFacing)), u.x, u.y, S);
          this._blit(ctx, Sprites.turret(u.typeKey, palTeam, aim), u.x + rx, u.y + ry, S);
        }
        if (u.driver) this._bar(ctx, u.x, u.y - u.radius - 6, u.radius * 2 + 4, u.armour / u.maxArmour, "#e8c050");
        // transports show one pip per passenger
        if (u.cargo && u.cargo.length) {
          for (let i = 0; i < u.cargo.length; i++) {
            ctx.fillStyle = "#fff"; ctx.fillRect(u.x - u.radius + 1 + i * 5, u.y + u.radius + 3, 3, 3);
            ctx.fillStyle = this._teamColor(u.team); ctx.fillRect(u.x - u.radius + 2 + i * 5, u.y + u.radius + 4, 1, 1);
          }
        }
      } else {
        const frame = u.moving ? (Math.floor(u.animClock) % 4) : 0;
        this._blit(ctx, Sprites.infantry(u.typeKey, palTeam, this._dirOf(u.facing), frame), u.x, u.y, S);
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

  // draw a unit's sprite, scaled to fit `size`px, centred at (cx,cy)
  _unitIcon(ctx, key, cx, cy, size = 26) {
    const team = "blue", dir = 2;          // facing the camera (south)
    const blit = (img) => { if (!img) return; const s = size / img.width; ctx.drawImage(img, Math.round(cx - img.width * s / 2), Math.round(cy - img.height * s / 2), Math.round(img.width * s), Math.round(img.height * s)); };
    if (INFANTRY_TYPES[key]) blit(Sprites.infantry(key, team, dir, 0));
    else if (key === "pillbox") { blit(Sprites.gunBase(team)); blit(Sprites.gunTurret(team, dir)); }
    else { blit(Sprites.hull(key, team, dir)); blit(Sprites.turret(key, team, dir)); }
  },

  // shared popup chrome: dark panel with a steel border
  _popupPanel(ctx, px, py, W, H) {
    ctx.fillStyle = "rgba(10,12,16,0.93)"; ctx.fillRect(px, py, W, H);
    ctx.fillStyle = "#2b3a44"; ctx.fillRect(px, py, W, 2); ctx.fillRect(px, py + H - 2, W, 2); ctx.fillRect(px, py, 2, H); ctx.fillRect(px + W - 2, py, 2, H);
  },

  // detail box used by both popups: stats line + counter hint + note
  _popupDetail(ctx, px, dy0, W, dkey) {
    const st = INFANTRY_TYPES[dkey] || VEHICLE_TYPES[dkey] || GUN_TYPES[dkey];
    ctx.fillStyle = "rgba(255,255,255,0.06)"; ctx.fillRect(px + 4, dy0, W - 8, 40);
    ctx.font = "8px monospace"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#ffd24a";
    const hp = st.hp !== undefined ? `HP ${st.hp}` : `ARM ${st.armour}`;
    const mr = st.minRange ? `  MIN ${st.minRange}` : "";
    ctx.fillText(`${hp}  DMG ${st.dmg}  RNG ${st.range}${mr}  SPD ${st.speed}`, px + 8, dy0 + 10);
    ctx.fillStyle = "#8fd0ff";
    ctx.fillText(`${st.cls} armour · strong vs ${STRONG_VS[st.dtype] || "-"}`, px + 8, dy0 + 21);
    ctx.fillStyle = "#9fb0c0";
    ctx.fillText(UNIT_NOTES[dkey] || "", px + 8, dy0 + 32);
  },

  // RTS-style popup above the selected factory: pick the unit to build, with
  // its sprite, stats and a short note.
  _drawFactoryPopup(ctx) {
    const f = Input.selectedFactory;
    if (!f) return;
    const keys = f.spec.keys, rowH = 30, W = 210, headH = 18, detailH = 46;
    const H = headH + keys.length * rowH + detailH + 6;
    const fsx = f.x - this.cam.x, fsy = f.y - this.cam.y;
    let px = Util.clamp(Math.round(fsx - W / 2), 4, CFG.VIEW_W - W - 4);
    let py = Math.round(fsy - 34 - H);
    if (py < 4) py = Math.round(fsy + 34);
    py = Util.clamp(py, 4, CFG.VIEW_H - H - 4);

    this._popupPanel(ctx, px, py, W, H);
    ctx.fillStyle = "#e8d98a"; ctx.font = "bold 10px monospace"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(f.ftype.toUpperCase() + " FACTORY", px + 8, py + headH / 2 + 1);

    const m = Input.mouse; let hover = -1, yy = py + headH;
    keys.forEach((key, i) => {
      const rx = px + 4, ry = yy + 1, rw = W - 8, rh = rowH - 2;
      const over = m.in && m.x >= rx && m.x <= rx + rw && m.y >= ry && m.y <= ry + rh;
      if (over) hover = i;
      const active = f.queueKey === key;
      ctx.fillStyle = active ? "rgba(77,166,255,0.30)" : over ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.04)";
      ctx.fillRect(rx, ry, rw, rh);
      if (active) { ctx.fillStyle = "#4da6ff"; ctx.fillRect(rx, ry, 3, rh); }
      this._unitIcon(ctx, key, rx + 16, ry + rh / 2, 26);
      ctx.fillStyle = active ? "#cfe3ff" : "#cfd6dc"; ctx.font = "10px monospace"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(G.unitName(key), rx + 32, ry + rh / 2);
      ctx.fillStyle = "#86d68a"; ctx.textAlign = "right"; ctx.fillText(G.baseTimeOf(key) + "s", rx + rw - 6, ry + rh / 2); ctx.textAlign = "left";
      Input.popupRects.push({ x: rx, y: ry, w: rw, h: rh, act: () => f.setQueue(key) });
      yy += rowH;
    });

    const dkey = hover >= 0 ? keys[hover] : f.queueKey;
    this._popupDetail(ctx, px, py + headH + keys.length * rowH + 2, W, dkey);
  },

  // HQ command popup over the fort: train / instant mana builds / upgrades.
  _drawFortPopup(ctx) {
    const fort = Input.selectedFort;
    if (!fort) return;
    const team = fort.team, mana = Math.floor(this.mana[team]);
    const W = 268, cell = 34, headH = 20, labH = 13, detailH = 46;
    const cols = Math.floor((W - 8) / cell);
    const trainRows = Math.ceil(FORT_TRAIN_KEYS.length / cols);
    const instRows = Math.ceil(INSTANT_KEYS.length / cols);
    const upH = 16 * 2 + 4;
    const H = headH + labH + trainRows * cell + labH + instRows * cell + labH + upH + detailH + 10;
    const fsx = fort.x - this.cam.x, fsy = fort.y - this.cam.y;
    let px = Util.clamp(Math.round(fsx - W / 2), 4, CFG.VIEW_W - W - 4);
    let py = Math.round(fsy - fort.h / 2 - 8 - H);
    if (py < 4) py = Math.round(fsy + fort.h / 2 + 8);
    py = Util.clamp(py, 4, CFG.VIEW_H - H - 4);

    this._popupPanel(ctx, px, py, W, H);
    // header: title + mana bar
    ctx.fillStyle = "#e8d98a"; ctx.font = "bold 10px monospace"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText("HEADQUARTERS", px + 8, py + 9);
    ctx.fillStyle = "#b98aff"; ctx.textAlign = "right";
    ctx.fillText(`⚡${mana}/${CFG.MANA_MAX}`, px + W - 8, py + 9); ctx.textAlign = "left";
    ctx.fillStyle = "#1c1430"; ctx.fillRect(px + 4, py + headH - 3, W - 8, 2);
    ctx.fillStyle = "#b98aff"; ctx.fillRect(px + 4, py + headH - 3, (W - 8) * (mana / CFG.MANA_MAX), 2);

    const m = Input.mouse; let hoverKey = null, hoverUp = null;
    const label = (text, y) => { ctx.fillStyle = "#6c7a72"; ctx.font = "8px monospace"; ctx.fillText(text, px + 6, y + labH / 2 + 1); };

    // icon grid helper for train / instant sections
    const grid = (keys, y0, mode) => {
      keys.forEach((key, i) => {
        const gx = px + 4 + (i % cols) * cell, gy = y0 + Math.floor(i / cols) * cell;
        const rw = cell - 2, rh = cell - 2;
        const over = m.in && m.x >= gx && m.x <= gx + rw && m.y >= gy && m.y <= gy + rh;
        if (over) hoverKey = key;
        const cost = this.manaCost(key);
        const cantPay = mode === "instant" && mana < cost;
        const active = mode === "train" && fort.trainKey === key;
        ctx.fillStyle = active ? "rgba(77,166,255,0.30)" : over ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)";
        ctx.fillRect(gx, gy, rw, rh);
        if (active) { ctx.fillStyle = "#4da6ff"; ctx.fillRect(gx, gy, rw, 3); }
        this._unitIcon(ctx, key, gx + rw / 2, gy + rh / 2 - 3, 26);
        if (mode === "instant") {
          ctx.fillStyle = cantPay ? "#5a4a6a" : "#d8c2ff"; ctx.font = "8px monospace"; ctx.textAlign = "center";
          ctx.fillText(String(cost), gx + rw / 2, gy + rh - 2); ctx.textAlign = "left";
          if (cantPay) { ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fillRect(gx, gy, rw, rh); }
          else Input.popupRects.push({ x: gx, y: gy, w: rw, h: rh, act: () => this.instantBuild(team, key) });
        } else {
          Input.popupRects.push({ x: gx, y: gy, w: rw, h: rh, act: () => fort.setTrain(key) });
        }
      });
    };

    let yy = py + headH;
    label("TRAIN (continuous)", yy); yy += labH;
    grid(FORT_TRAIN_KEYS, yy, "train"); yy += trainRows * cell;
    label("INSTANT BUILD (mana)", yy); yy += labH;
    grid(INSTANT_KEYS, yy, "instant"); yy += instRows * cell;
    label("UPGRADES (mana)", yy); yy += labH;

    // 2x2 upgrade buttons with level pips
    UPGRADE_DEFS.forEach((def, i) => {
      const bw = (W - 12) / 2, bx = px + 4 + (i % 2) * (bw + 4), by = yy + Math.floor(i / 2) * 18;
      const lvl = this.upgrades[team][def.key], maxed = lvl >= CFG.UPGRADE_MAX;
      const cost = maxed ? 0 : CFG.UPGRADE_COST[lvl];
      const over = m.in && m.x >= bx && m.x <= bx + bw && m.y >= by && m.y <= by + 16;
      if (over) hoverUp = def;
      const cantPay = !maxed && mana < cost;
      ctx.fillStyle = over && !maxed && !cantPay ? "rgba(185,138,255,0.25)" : "rgba(255,255,255,0.06)";
      ctx.fillRect(bx, by, bw, 16);
      ctx.fillStyle = maxed ? "#86d68a" : cantPay ? "#5a4a6a" : "#cfd6dc"; ctx.font = "8px monospace";
      ctx.fillText(maxed ? `${def.name} MAX` : `${def.name} ⚡${cost}`, bx + 4, by + 8);
      for (let p = 0; p < CFG.UPGRADE_MAX; p++) {                      // level pips
        ctx.fillStyle = p < lvl ? "#b98aff" : "#2b2438";
        ctx.fillRect(bx + bw - 16 + p * 5, by + 6, 3, 3);
      }
      if (!maxed && !cantPay) Input.popupRects.push({ x: bx, y: by, w: bw, h: 16, act: () => this.buyUpgrade(team, def.key) });
    });
    yy += upH;

    if (hoverUp) {
      ctx.fillStyle = "rgba(255,255,255,0.06)"; ctx.fillRect(px + 4, yy, W - 8, detailH);
      ctx.fillStyle = "#8fd0ff"; ctx.font = "8px monospace"; ctx.textBaseline = "alphabetic";
      ctx.fillText(`${hoverUp.name}: +${Math.round(CFG.UPGRADE_STEP * 100)}% per level`, px + 8, yy + 14);
      ctx.fillStyle = "#9fb0c0";
      ctx.fillText("Applies to every unit, present and future.", px + 8, yy + 26);
    } else {
      this._popupDetail(ctx, px, yy, W, hoverKey || fort.trainKey);
    }
  },

  _drawMinimap(ctx) {
    const mw = 168, mh = Math.round(mw * CFG.ROWS / CFG.COLS);
    const ox = this.canvas.width - mw - 8, oy = 8;
    const sx = mw / this.worldW(), sy = mh / this.worldH();
    this.mm = { ox, oy, w: mw, h: mh };              // remembered for click-to-pan
    ctx.fillStyle = "rgba(8,10,12,0.85)"; ctx.fillRect(ox - 2, oy - 2, mw + 4, mh + 4);
    // sectors (irregular regions via fill runs)
    const T = CFG.TILE;
    for (const s of this.sectors) {
      ctx.fillStyle = s.owner === TEAM.BLUE ? "rgba(77,166,255,0.55)" : s.owner === TEAM.RED ? "rgba(255,91,91,0.55)" : "rgba(120,110,90,0.5)";
      for (const r of s.runs) ctx.fillRect(ox + r.x0 * T * sx, oy + r.y * T * sy, (r.x1 - r.x0 + 1) * T * sx + 0.6, T * sy + 0.6);
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
    // attack pings: expanding rings where the player is taking hits
    for (const p of this.pings) {
      const age = (this.time - p.born) / 3;
      const r = 3 + age * 9;
      ctx.strokeStyle = `rgba(255,80,80,${0.9 * (1 - age)})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(ox + p.x * sx, oy + p.y * sy, r, 0, Math.PI * 2); ctx.stroke();
    }
    // camera viewport rectangle
    ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1;
    ctx.strokeRect(ox + this.cam.x * sx, oy + this.cam.y * sy, CFG.VIEW_W * sx, CFG.VIEW_H * sy);
    ctx.strokeStyle = "#2b3a44"; ctx.strokeRect(ox - 2, oy - 2, mw + 4, mh + 4);
  },

  _bar(ctx, cx, y, w, frac, col) {
    frac = Util.clamp(frac, 0, 1);
    ctx.fillStyle = "#000"; ctx.fillRect(cx - w / 2, y, w, 3);
    ctx.fillStyle = col; ctx.fillRect(cx - w / 2, y, w * frac, 3);
  },

  // tiny 3x5 pixel font for the factory countdown readouts
  _drawDigits(ctx, x, y, text, color) {
    ctx.fillStyle = color;
    let cx = x;
    for (const ch of text) {
      const rows = PXFONT[ch] || PXFONT[" "];
      const w = rows[0].length;
      for (let r = 0; r < 5; r++) for (let c = 0; c < w; c++) if (rows[r][c] === "1") ctx.fillRect(cx + c, y + r, 1, 1);
      cx += w + 1;
    }
  },

  _drawProjectiles(ctx) {
    for (const p of this.projectiles) {
      if (!this._inView(p.x, p.y)) continue;
      if (p.sniper) {
        PX.line(ctx, p.x, p.y, p.x - (p.tx - p.x) * 0.05, p.y - (p.ty - p.y) * 0.05, "#fff", 2, 2);
      } else if (p.ballistic && p.arc) {
        // arcing rocket: ground shadow + the round drawn at its arc height
        const h = p.arcHeight();
        PX.fillOval(ctx, p.x, p.y, 3, 2, "rgba(0,0,0,0.25)", 2);
        ctx.fillStyle = "#2a2a2a";
        ctx.fillRect(Math.floor(p.x / 2) * 2 - 1, Math.floor((p.y - h) / 2) * 2 - 1, 4, 4);
        ctx.fillStyle = "#ffd24a";
        ctx.fillRect(Math.floor(p.x / 2) * 2, Math.floor((p.y - h) / 2) * 2, 2, 2);
      } else if (p.ballistic) {
        // cannon shell: a dark slug with a hot tail
        ctx.fillStyle = "#1c1c1c";
        ctx.fillRect(Math.floor(p.x / 2) * 2 - 1, Math.floor(p.y / 2) * 2 - 1, 4, 4);
        ctx.fillStyle = "#ffcf5b";
        ctx.fillRect(Math.floor(p.x / 2) * 2, Math.floor(p.y / 2) * 2, 2, 2);
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
      const ex = e.x !== undefined ? e.x : e.x1, ey = e.y !== undefined ? e.y : e.y1;
      if (!this._inView(ex, ey, 60)) continue;
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
      } else if (e instanceof CommandMarker) {
        const p = e.t / e.life, a = 1 - p;
        const col = this._cmdColor(e.kind);
        ctx.globalAlpha = a;
        PX.ring(ctx, e.x, e.y, 4 + p * 9, col, 2, 2, 1);   // expanding ring
        this._cmdIcon(ctx, e.kind, e.x, e.y, col);
        ctx.globalAlpha = 1;
      } else if (e instanceof SmokePuff) {
        const p = e.t / e.life, a = (1 - p);
        const r = (2 + p * 5) * e.scale;
        const col = e.dark ? `rgba(30,28,26,${0.5 * a})` : `rgba(120,112,104,${0.4 * a})`;
        PX.fillCircle(ctx, e.x, e.y, r, col, 2);
        if (e.dark && p < 0.25) PX.fillCircle(ctx, e.x, e.y + 2, 2, `rgba(255,140,40,${0.7 * (1 - p * 4)})`, 2);
      } else if (e instanceof FloatText) {
        const a = 1 - e.t / e.life;
        ctx.font = "bold 9px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.globalAlpha = a;
        ctx.fillStyle = "#000"; ctx.fillText(e.text, e.x + 1, e.y + 1);
        ctx.fillStyle = e.color; ctx.fillText(e.text, e.x, e.y);
        ctx.globalAlpha = 1; ctx.textAlign = "left";
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

  // bottom-left summary of the current selection: one cell per unit type with
  // a sprite, count, best rank, and (for transports) a cargo readout
  _drawSelectionPanel(ctx) {
    const sel = this.units.filter(u => u.selected && u.alive);
    if (!sel.length) return;
    // group by type
    const byType = new Map();
    for (const u of sel) {
      let g = byType.get(u.typeKey);
      if (!g) { g = { key: u.typeKey, n: 0, rank: 0, kills: 0, hp: 0, max: 0 }; byType.set(u.typeKey, g); }
      g.n++; g.rank = Math.max(g.rank, u.rank); g.kills += u.kills;
      g.hp += u.kind === "infantry" ? u.hp : u.armour;
      g.max += u.kind === "infantry" ? u.maxHp : u.maxArmour;
    }
    const groups = [...byType.values()];
    const cell = 42, W = Math.max(150, groups.length * cell + 8), H = 64;
    const ox = 8, oy = CFG.VIEW_H - H - 8;
    this._popupPanel(ctx, ox, oy, W, H);
    ctx.font = "8px monospace"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#6c7a72";
    ctx.fillText(`${sel.length} SELECTED`, ox + 6, oy + 8);
    groups.forEach((g, i) => {
      const gx = ox + 4 + i * cell, gy = oy + 14;
      ctx.fillStyle = "rgba(255,255,255,0.06)"; ctx.fillRect(gx, gy, cell - 2, 34);
      this._unitIcon(ctx, g.key, gx + 14, gy + 15, 24);
      ctx.fillStyle = "#cfd6dc"; ctx.textAlign = "right";
      ctx.fillText("×" + g.n, gx + cell - 5, gy + 8); ctx.textAlign = "left";
      // health fraction + chevrons of the best rank in the group
      this._bar(ctx, gx + (cell - 2) / 2, gy + 28, cell - 10, g.hp / (g.max || 1), "#7d7");
      if (g.rank > 0) {
        ctx.fillStyle = g.rank >= 3 ? "#ffe24a" : "#e8e8e8";
        for (let r = 0; r < g.rank; r++) ctx.fillRect(gx + 28 + r * 3, gy + 3, 2, 2);
      }
    });
    // single APC: show cargo + the unload hint
    const apc = sel.length === 1 && sel[0].cargo ? sel[0] : null;
    if (apc) {
      ctx.fillStyle = "#8fd0ff";
      ctx.fillText(`CARGO ${apc.cargo.length}/${apc.stats.transport}` + (apc.cargo.length ? " — U unloads" : " — right-click with infantry"), ox + 6, oy + H - 7);
    }
  },
};

// 3x5 pixel digits for factory countdown displays
const PXFONT = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  ":": ["0", "0", "1", "0", "1"],
  " ": ["00", "00", "00", "00", "00"],
};

window.addEventListener("load", () => G.init());
