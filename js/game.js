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
  walls: new Map(),         // key -> hp  (destructible)
  terrain: null,            // Uint8Array: 0 grass, 1 rock, 2 wall
  time: 0,
  dt: 0,
  running: false,
  over: false,

  /* ---- terrain helpers ------------------------------------------------ */
  tkey(tx, ty) { return ty * CFG.COLS + tx; },

  tilePassable(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= CFG.COLS || ty >= CFG.ROWS) return false;
    const t = this.terrain[this.tkey(tx, ty)];
    if (t === 1) return false;                 // solid rock
    if (t === 2 && this.walls.get(this.tkey(tx, ty)) > 0) return false; // wall
    return true;
  },
  tilePassableIgnoreWall(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= CFG.COLS || ty >= CFG.ROWS) return false;
    return this.terrain[this.tkey(tx, ty)] !== 1;   // only solid rock blocks
  },
  isWall(tx, ty) {
    return this.terrain[this.tkey(tx, ty)] === 2 && this.walls.get(this.tkey(tx, ty)) > 0;
  },
  damageWall(tx, ty, dmg) {
    const k = this.tkey(tx, ty);
    if (this.terrain[k] !== 2) return;
    const hp = (this.walls.get(k) || 0) - dmg;
    if (hp <= 0) { this.walls.delete(k); this.terrain[k] = 0; this.fx.push(new Explosion(Util.cx(tx), Util.cy(ty), 10)); }
    else this.walls.set(k, hp);
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
    this.terrain = new Uint8Array(N); // all grass

    // scatter solid rock clusters
    for (let i = 0; i < 16; i++) {
      const cx = Util.randInt(6, CFG.COLS - 6), cy = Util.randInt(4, CFG.ROWS - 4);
      const rw = Util.randInt(1, 3), rh = Util.randInt(1, 3);
      for (let y = cy - rh; y <= cy + rh; y++)
        for (let x = cx - rw; x <= cx + rw; x++)
          if (this._inBounds(x, y) && Util.chance(0.7)) this.terrain[this.tkey(x, y)] = 1;
    }

    // destructible wall barriers across the middle (with gaps), to show off
    // units shooting through walls when boxed in.
    const midX = Math.floor(CFG.COLS / 2);
    for (let y = 0; y < CFG.ROWS; y++) {
      if (y % 7 === 3) continue;                 // leave gaps
      for (const wx of [midX - 8, midX, midX + 8]) {
        if (Util.chance(0.85)) { this.terrain[this.tkey(wx, y)] = 2; this.walls.set(this.tkey(wx, y), 60); }
      }
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
  },

  _inBounds(x, y) { return x >= 0 && y >= 0 && x < CFG.COLS && y < CFG.ROWS; },

  _clearArea(tx, ty, r) {
    for (let y = ty - r; y <= ty + r; y++)
      for (let x = tx - r; x <= tx + r; x++)
        if (this._inBounds(x, y)) { this.terrain[this.tkey(x, y)] = 0; this.walls.delete(this.tkey(x, y)); }
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
    this.time += dt;

    this.commander.update(dt);

    for (const u of this.units) UnitAI.think(u);
    for (const u of this.units) u.update(dt);
    for (const f of this.factories) f.update(dt);
    for (const f of this.forts) f.update(dt);

    for (const p of this.projectiles) p.update(dt);
    for (const e of this.fx) e.update(dt);

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
    const c = bg.getContext("2d");
    const T = CFG.TILE;
    for (let y = 0; y < CFG.ROWS; y++) {
      for (let x = 0; x < CFG.COLS; x++) {
        const t = this.terrain[this.tkey(x, y)];
        if (t === 1) {
          c.fillStyle = CFG.COLORS.rockDk; c.fillRect(x * T, y * T, T, T);
          c.fillStyle = CFG.COLORS.rock; c.fillRect(x * T + 2, y * T + 2, T - 4, T - 4);
        } else {
          c.fillStyle = ((x + y) & 1) ? CFG.COLORS.grass : CFG.COLORS.grass2;
          c.fillRect(x * T, y * T, T, T);
        }
      }
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
      if (s.flash > 0) { ctx.fillStyle = `rgba(${col},${0.25 * s.flash})`; ctx.fillRect(s.px, s.py, s.pw, s.ph); }
      ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 2;
      ctx.strokeRect(s.px + 1, s.py + 1, s.pw - 2, s.ph - 2);
    }

    // destructible walls (dynamic)
    for (const [k, hp] of this.walls) {
      const x = (k % CFG.COLS) * T, y = Math.floor(k / CFG.COLS) * T;
      const dmg = Util.clamp(hp / 60, 0, 1);
      ctx.fillStyle = CFG.COLORS.wall; ctx.fillRect(x, y, T, T);
      ctx.fillStyle = "rgba(0,0,0," + (0.5 * (1 - dmg)) + ")"; ctx.fillRect(x, y, T, T);
      ctx.strokeStyle = "#5a4d35"; ctx.strokeRect(x + 0.5, y + 0.5, T - 1, T - 1);
    }

    this._drawFlags(ctx);
    this._drawFactories(ctx);
    this._drawForts(ctx);
    this._drawFx(ctx);
    this._drawProjectiles(ctx);
    this._drawUnits(ctx);
    this._drawSelectionBox(ctx);
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
      ctx.fillStyle = this._teamColor(s.owner);
      ctx.beginPath();
      ctx.moveTo(f.x + 1, f.y - 14);
      ctx.lineTo(f.x + 12, f.y - 11);
      ctx.lineTo(f.x + 1, f.y - 8);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,0.4)"; ctx.fillRect(f.x - 3, f.y + 3, 6, 2);
    }
  },

  _drawFactories(ctx) {
    const T = CFG.TILE;
    for (const f of this.factories) {
      const x = f.x, y = f.y;
      const w = T * 1.8, h = T * 1.6;
      ctx.fillStyle = "#2b2b30"; ctx.fillRect(x - w / 2, y - h / 2, w, h);
      ctx.fillStyle = this._teamDark(f.team); ctx.fillRect(x - w / 2, y - h / 2, w, 5); // roof
      // type letter
      ctx.fillStyle = this._teamColor(f.team);
      ctx.font = "bold 10px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(f.ftype[0].toUpperCase(), x, y + 1);
      // build progress
      if (f.team !== TEAM.NEUTRAL) {
        const frac = f.buildFraction();
        ctx.fillStyle = "#000"; ctx.fillRect(x - w / 2, y + h / 2 + 1, w, 3);
        ctx.fillStyle = this._teamColor(f.team); ctx.fillRect(x - w / 2, y + h / 2 + 1, w * frac, 3);
      }
      // hp bar if damaged
      if (f.hp < f.maxHp) this._bar(ctx, x, y - h / 2 - 4, w, f.hp / f.maxHp, "#7d7");
    }
  },

  _drawForts(ctx) {
    for (const f of this.forts) {
      if (!f.alive) {
        ctx.fillStyle = "#222"; ctx.fillRect(f.x - f.w / 2, f.y - f.h / 2, f.w, f.h);
        continue;
      }
      const x = f.x - f.w / 2, y = f.y - f.h / 2;
      ctx.fillStyle = this._teamDark(f.team); ctx.fillRect(x, y, f.w, f.h);
      ctx.fillStyle = "#1c1c1c"; ctx.fillRect(x + 4, y + 4, f.w - 8, f.h - 8);
      // battlements
      ctx.fillStyle = this._teamDark(f.team);
      for (let bx = x; bx < x + f.w; bx += 8) ctx.fillRect(bx, y - 3, 5, 4);
      // entry marker
      ctx.fillStyle = this._teamColor(f.team);
      ctx.fillRect(Util.cx(f.entry.x) - 5, Util.cy(f.entry.y) - 5, 10, 10);
      ctx.fillStyle = "#000"; ctx.font = "8px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("▼", Util.cx(f.entry.x), Util.cy(f.entry.y));
      // turret nub
      ctx.fillStyle = "#111"; ctx.beginPath(); ctx.arc(f.x, f.y, 5, 0, 7); ctx.fill();
      // hp bar
      this._bar(ctx, f.x, y - 8, f.w, f.hp / f.maxHp, this._teamColor(f.team));
    }
  },

  _drawUnits(ctx) {
    for (const u of this.units) {
      const c = this._teamColor(u.team), d = this._teamDark(u.team);
      if (u.kind === "machine") {
        const w = u.radius * 2, h = u.radius * 1.7;
        ctx.save(); ctx.translate(u.x, u.y); ctx.rotate(u.facing);
        ctx.fillStyle = u.driver ? d : "#555"; ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.fillStyle = u.driver ? c : "#888"; ctx.fillRect(-w / 2 + 2, -h / 2 + 2, w - 4, h - 4);
        // barrel
        ctx.fillStyle = "#111"; ctx.fillRect(0, -2, u.radius + (u.immobile ? 6 : 8), 4);
        if (u.immobile) { ctx.fillStyle = "#222"; ctx.fillRect(-w/2, -h/2, w, 3); } // gun base
        ctx.restore();
        // armour bar
        if (u.driver) this._bar(ctx, u.x, u.y - u.radius - 5, w + 4, u.armour / u.maxArmour, "#e8c050");
      } else {
        // infantry: little diamond, sniper drawn with a long marker
        ctx.fillStyle = "#000";
        ctx.beginPath(); ctx.arc(u.x, u.y, u.radius + 1, 0, 7); ctx.fill();
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.arc(u.x, u.y, u.radius, 0, 7); ctx.fill();
        // type pip
        ctx.fillStyle = "#000";
        const pip = { grunt: "", psycho: "✕", sniper: "·", pyro: "▲" }[u.typeKey] || "";
        ctx.font = "7px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(pip, u.x, u.y);
        // facing tick
        ctx.strokeStyle = "#000"; ctx.beginPath(); ctx.moveTo(u.x, u.y);
        ctx.lineTo(u.x + Math.cos(u.facing) * (u.radius + 3), u.y + Math.sin(u.facing) * (u.radius + 3)); ctx.stroke();
        this._bar(ctx, u.x, u.y - u.radius - 5, u.radius * 2 + 2, u.hp / u.maxHp, "#7d7");
      }
      if (u.selected) {
        ctx.strokeStyle = "#9cff6a"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(u.x, u.y, u.radius + 4, 0, 7); ctx.stroke();
      }
      if (u.holdPosition) {
        ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(u.x, u.y, u.radius + 6, 0, 7); ctx.stroke();
      }
    }
  },

  _bar(ctx, cx, y, w, frac, col) {
    frac = Util.clamp(frac, 0, 1);
    ctx.fillStyle = "#000"; ctx.fillRect(cx - w / 2, y, w, 3);
    ctx.fillStyle = col; ctx.fillRect(cx - w / 2, y, w * frac, 3);
  },

  _drawProjectiles(ctx) {
    for (const p of this.projectiles) {
      if (p.sniper) {
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - (p.tx - p.x) * 0.04, p.y - (p.ty - p.y) * 0.04); ctx.stroke();
      } else {
        ctx.fillStyle = p.team === TEAM.BLUE ? "#bfe0ff" : p.team === TEAM.RED ? "#ffd0d0" : "#ffe";
        ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
      }
    }
  },

  _drawFx(ctx) {
    for (const e of this.fx) {
      if (e instanceof Explosion) {
        const f = e.t / e.life;
        ctx.fillStyle = `rgba(255,${Math.floor(180 * (1 - f))},40,${1 - f})`;
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.4 + f), 0, 7); ctx.fill();
        ctx.fillStyle = `rgba(255,240,180,${(1 - f) * 0.8})`;
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 0.5 * (1 - f), 0, 7); ctx.fill();
      } else if (e instanceof Spark) {
        ctx.fillStyle = e.c; ctx.fillRect(e.x - 2, e.y - 2, 4, 4);
      } else if (e instanceof Tracer) {
        ctx.strokeStyle = this._teamColor(e.team); ctx.lineWidth = 1.2;
        ctx.globalAlpha = 1 - e.t / e.life;
        ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); ctx.stroke();
        ctx.globalAlpha = 1;
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
