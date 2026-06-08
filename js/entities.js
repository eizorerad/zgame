/* =========================================================================
 * entities.js — game objects.
 *
 *   Unit      : infantry OR machine (vehicle / gun). Machines are inert
 *               until crewed; their team follows their driver.
 *   Flag      : sector ownership switch (state machine in sectors.js).
 *   Factory   : produces units; production time scales with sectors owned.
 *   Fort      : home base, automated turrets, win target.
 *   Projectile: visual + delivery of damage.
 *
 * `G` (the global game, defined in game.js) is used for world queries.
 * ========================================================================= */

/* -------------------------------------------------------------------------
 * Unit
 * ---------------------------------------------------------------------- */
class Unit {
  constructor(kind, typeKey, team, x, y) {
    this.id = Util.uid();
    this.kind = kind;            // "infantry" | "machine"
    this.typeKey = typeKey;
    this.x = x; this.y = y;
    this.alive = true;
    this.selected = false;
    this.facing = 0;

    const table = kind === "infantry" ? INFANTRY_TYPES
                : (VEHICLE_TYPES[typeKey] ? VEHICLE_TYPES : GUN_TYPES);
    this.stats = table[typeKey];

    if (kind === "infantry") {
      this.hp = this.stats.hp;
      this.maxHp = this.stats.hp;
      this.team = team;
      this.driver = null;
    } else {
      // machine: armour pool + a driver. Team is derived from the driver.
      this.armour = this.stats.armour;
      this.maxArmour = this.stats.armour;
      this.driver = team ? { team } : null;   // pre-crewed when produced
      this.immobile = !!this.stats.immobile;
    }

    // order / movement
    this.order = "idle";         // idle | move | attack | hold
    this.holdPosition = false;
    this.path = [];              // array of {x,y} tile coords
    this.wpx = null; this.wpy = null;  // current waypoint pixel target
    this.goalTx = null; this.goalTy = null;
    this.target = null;          // entity being attacked (effective)
    this.commandAttack = null;   // explicit player/AI attack order
    this.moveGoalX = null;       // remembered move destination (resume after combat)
    this.moveGoalY = null;
    this.wallTarget = null;      // {tx,ty} wall we're clearing
    this.repathTimer = 0;

    // combat
    this.cooldown = 0;
    this.aggro = this.stats.aggro || CFG.DEFAULT_AGGRO;
  }

  get team() {
    if (this.kind === "machine") return this.driver ? this.driver.team : TEAM.NEUTRAL;
    return this._team;
  }
  set team(t) { this._team = t; }

  get radius() { return this.stats.radius; }
  get speed() { return this.kind === "machine" && this.immobile ? 0 : this.stats.speed; }
  get range() { return this.stats.range; }
  get crewed() { return this.kind === "infantry" || !!this.driver; }

  isVehicle() { return this.kind === "machine" && !this.immobile; }
  isGun() { return this.kind === "machine" && this.immobile; }
  isSniper() { return this.kind === "infantry" && this.typeKey === "sniper"; }

  /* ---- orders -------------------------------------------------------- */
  orderMove(px, py) {
    this.order = "move";
    this.target = null;
    this.commandAttack = null;
    this.holdPosition = false;
    this.moveGoalX = px; this.moveGoalY = py;
    this._setGoal(px, py);
  }

  orderAttack(entity) {
    this.order = "attack";
    this.commandAttack = entity;
    this.target = entity;
    this.holdPosition = false;
    this.wallTarget = null;
    this.moveGoalX = this.moveGoalY = null;
  }

  orderHold() {
    this.holdPosition = true;
    this.order = "hold";
    this.path = []; this.wpx = this.wpy = null;
    this.target = null; this.commandAttack = null;
    this.moveGoalX = this.moveGoalY = null;
  }

  stop() {
    this.order = "idle";
    this.path = []; this.wpx = this.wpy = null;
    this.goalTx = this.goalTy = null;
    this.moveGoalX = this.moveGoalY = null;
  }

  _setGoal(px, py) {
    this.goalTx = Util.tx(px); this.goalTy = Util.ty(py);
    this.recomputePath();
  }

  recomputePath() {
    if (this.goalTx == null) return;
    const sx = Util.tx(this.x), sy = Util.ty(this.y);
    const res = Path.find(
      sx, sy, this.goalTx, this.goalTy,
      (tx, ty) => G.tilePassable(tx, ty),
      (tx, ty) => G.tilePassableIgnoreWall(tx, ty)
    );
    this.path = res.tiles;
    this.advanceWaypoint();
    // Blocked only by a destructible wall -> go clear it.
    if (res.blockedByWall) {
      this.wallTarget = res.blockedByWall;
    } else {
      this.wallTarget = null;
    }
  }

  advanceWaypoint() {
    if (this.path.length) {
      const t = this.path.shift();
      this.wpx = Util.cx(t.x); this.wpy = Util.cy(t.y);
    } else {
      this.wpx = this.wpy = null;
    }
  }

  /* ---- per-frame movement + combat execution ------------------------- */
  update(dt) {
    if (!this.alive) return;
    if (this.cooldown > 0) this.cooldown -= dt;

    // Empty machines just sit there waiting to be crewed.
    if (this.kind === "machine" && !this.driver) return;

    // Attacking a wall to clear a path.
    if (this.wallTarget) {
      this._fightWall(dt);
      return;
    }

    // Combat target in range -> shoot, otherwise close distance.
    if (this.target && this.target.alive) {
      const d = Util.dist(this.x, this.y, this.target.x, this.target.y);
      if (d <= this.range) {
        this.faceTo(this.target.x, this.target.y);
        this._fire(this.target);
        // tanks/guns hold ground while firing; infantry too
        return;
      } else if (!this.holdPosition) {
        // chase
        if (this.goalTx !== Util.tx(this.target.x) || this.goalTy !== Util.ty(this.target.y)) {
          this._setGoal(this.target.x, this.target.y);
        }
      } else {
        return; // hold position, target out of range -> stand
      }
    }

    this._followPath(dt);
  }

  _followPath(dt) {
    if (this.wpx == null) return;
    const dx = this.wpx - this.x, dy = this.wpy - this.y;
    const d = Math.hypot(dx, dy);
    if (d < 2) { this.advanceWaypoint(); return; }
    const sp = this.speed * dt;
    const nx = this.x + (dx / d) * sp;
    const ny = this.y + (dy / d) * sp;
    this.faceTo(this.wpx, this.wpy);
    // block on freshly-changed walls
    if (G.tilePassable(Util.tx(nx), Util.ty(ny))) {
      this.x = nx; this.y = ny;
    } else {
      this.recomputePath();
    }
    if (this.path.length === 0 && Math.hypot(this.wpx - this.x, this.wpy - this.y) < 2) {
      this.stop();
    }
  }

  _fightWall(dt) {
    const w = this.wallTarget;
    const wx = Util.cx(w.x), wy = Util.cy(w.y);
    const d = Util.dist(this.x, this.y, wx, wy);
    if (!G.isWall(w.x, w.y)) { this.wallTarget = null; this.recomputePath(); return; }
    if (d <= this.range) {
      this.faceTo(wx, wy);
      if (this.cooldown <= 0) {
        this.cooldown = this.stats.cooldown;
        G.spawnProjectile(this, { x: wx, y: wy, isWall: true, tx: w.x, ty: w.y }, false);
      }
    } else {
      // approach the wall
      const dx = wx - this.x, dy = wy - this.y, dd = Math.hypot(dx, dy);
      this.x += (dx / dd) * this.speed * dt;
      this.y += (dy / dd) * this.speed * dt;
      this.faceTo(wx, wy);
    }
  }

  _fire(target) {
    if (this.cooldown > 0) return;
    this.cooldown = this.stats.cooldown;
    const sniper = this.isSniper() && Util.chance(this.stats.snipeChance || 0);
    G.spawnProjectile(this, target, sniper);
  }

  faceTo(px, py) { this.facing = Math.atan2(py - this.y, px - this.x); }

  /* ---- damage -------------------------------------------------------- */
  applyDamage(amount, attacker, sniperKill) {
    if (!this.alive) return;
    if (this.kind === "infantry") {
      this.hp -= amount;
      if (this.hp <= 0) this.die();
      return;
    }
    // machine
    if (sniperKill && this.driver) {
      // Sniper bypasses armour and kills the driver. Machine survives, empty.
      this.ejectDriver(true);
      G.fx.push(new Spark(this.x, this.y, "#fff"));
      return;
    }
    this.armour -= amount;
    if (this.armour <= 0) this.die();
  }

  ejectDriver(killed) {
    if (this.driver) {
      this.driver = null;        // becomes neutral & inert
      this.order = "idle";
      this.path = []; this.wpx = this.wpy = null;
      this.target = null; this.selected = false;
    }
  }

  die() {
    this.alive = false;
    G.fx.push(new Explosion(this.x, this.y, this.kind === "machine" ? 18 : 9));
  }
}

/* -------------------------------------------------------------------------
 * Flag — the sector switch. The state machine lives in sectors.js, but the
 * flag holds the visual + capture-radius check.
 * ---------------------------------------------------------------------- */
class Flag {
  constructor(sector, x, y) {
    this.sector = sector;
    this.x = x; this.y = y;
    this.flick = 0;
  }
  get team() { return this.sector.owner; }
}

/* -------------------------------------------------------------------------
 * Factory — builds units. Production time scales with the owning team's
 * sector count. Flipping the parent sector resets the queue (handled in
 * sectors.js by clearing progress).
 * ---------------------------------------------------------------------- */
class Factory {
  constructor(sector, x, y, ftype) {
    this.sector = sector;
    this.x = x; this.y = y;
    this.ftype = ftype;                  // "robot" | "vehicle" | "gun"
    this.spec = FACTORY_OUTPUT[ftype];
    this.queueKey = this.spec.keys[0];   // currently selected unit to build
    this.progress = 0;                   // seconds accumulated
    this.hp = 220; this.maxHp = 220;
    this.alive = true;
    this.rally = null;                   // {x,y} rally point
  }

  get team() { return this.sector.owner; }

  setQueue(key) {
    if (this.queueKey !== key) {
      this.queueKey = key;
      this.progress = 0;   // changing product restarts the build
    }
  }

  // Called when the sector flips owners: discard in-progress build.
  onOwnerChanged() {
    this.progress = 0;
    this.queueKey = this.spec.keys[0];
  }

  update(dt) {
    if (this.team === TEAM.NEUTRAL) return;
    const base = this.spec.table[this.queueKey].baseTime;
    const actual = G.actualBuildTime(base, this.team);
    this.progress += dt;
    if (this.progress >= actual) {
      this.progress = 0;
      this._produce();
    }
  }

  applyDamage(amount) {
    this.hp -= amount;
    if (this.hp <= 0) { this.hp = 0; this.alive = false; G.fx.push(new Explosion(this.x, this.y, 20)); }
  }

  buildFraction() {
    if (this.team === TEAM.NEUTRAL) return 0;
    const base = this.spec.table[this.queueKey].baseTime;
    return Util.clamp(this.progress / G.actualBuildTime(base, this.team), 0, 1);
  }

  _produce() {
    // spawn just below the factory at a free tile
    const spot = G.freeSpotNear(this.x, this.y + CFG.TILE * 1.4);
    let u;
    if (this.spec.kind === "infantry") {
      u = new Unit("infantry", this.queueKey, this.team, spot.x, spot.y);
    } else {
      u = new Unit("machine", this.queueKey, this.team, spot.x, spot.y);
    }
    G.units.push(u);
    if (this.rally) u.orderMove(this.rally.x, this.rally.y);
  }
}

/* -------------------------------------------------------------------------
 * Fort — home base. Automated turrets, and a win target.
 * ---------------------------------------------------------------------- */
class Fort {
  constructor(team, x, y, entryTile) {
    this.team = team;
    this.x = x; this.y = y;
    this.hp = CFG.FORT_HP; this.maxHp = CFG.FORT_HP;
    this.alive = true;
    this.entry = entryTile;          // {x,y} tile that triggers infiltration win
    this.turretCd = 0;
    this.w = CFG.TILE * 5;
    this.h = CFG.TILE * 4;
  }

  update(dt) {
    if (!this.alive) return;
    if (this.turretCd > 0) this.turretCd -= dt;
    if (this.turretCd <= 0) {
      const foe = G.nearestEnemyUnit(this.x, this.y, this.team, CFG.FORT_TURRET_RANGE);
      if (foe) {
        this.turretCd = CFG.FORT_TURRET_COOLDOWN;
        G.fx.push(new Tracer(this.x, this.y, foe.x, foe.y, this.team));
        foe.applyDamage(CFG.FORT_TURRET_DMG, this, false);
      }
    }
  }

  applyDamage(amount) {
    this.hp -= amount;
    if (this.hp <= 0) { this.hp = 0; this.alive = false; }
  }
}

/* -------------------------------------------------------------------------
 * Projectile — flies from attacker to target, then delivers damage.
 * ---------------------------------------------------------------------- */
class Projectile {
  constructor(attacker, target, sniper) {
    this.x = attacker.x; this.y = attacker.y;
    this.team = attacker.team;
    this.attacker = attacker;
    this.target = target;
    this.dmg = attacker.stats.dmg;
    this.sniper = sniper;
    this.speed = sniper ? 700 : 320;
    this.alive = true;
    this.tx = target.x; this.ty = target.y;
  }
  update(dt) {
    const t = this.target;
    if (t && t.alive !== false && !t.isWall) { this.tx = t.x; this.ty = t.y; }
    const dx = this.tx - this.x, dy = this.ty - this.y;
    const d = Math.hypot(dx, dy);
    const step = this.speed * dt;
    if (d <= step) {
      this._hit();
      this.alive = false;
      return;
    }
    this.x += (dx / d) * step;
    this.y += (dy / d) * step;
  }
  _hit() {
    const t = this.target;
    if (t && t.isWall) {
      G.damageWall(t.tx, t.ty, this.dmg);
      G.fx.push(new Spark(this.tx, this.ty, "#caa"));
      return;
    }
    if (t && t.alive) {
      t.applyDamage(this.dmg, this.attacker, this.sniper);
      G.fx.push(new Spark(t.x, t.y, this.sniper ? "#fff" : "#ffcf5b"));
    }
  }
}

/* ---- lightweight visual effects ---------------------------------------- */
class Explosion {
  constructor(x, y, r) { this.x = x; this.y = y; this.r = r; this.t = 0; this.life = 0.45; this.alive = true; }
  update(dt) { this.t += dt; if (this.t >= this.life) this.alive = false; }
}
class Spark {
  constructor(x, y, c) { this.x = x; this.y = y; this.c = c; this.t = 0; this.life = 0.18; this.alive = true; }
  update(dt) { this.t += dt; if (this.t >= this.life) this.alive = false; }
}
class Tracer {
  constructor(x1, y1, x2, y2, team) { this.x1 = x1; this.y1 = y1; this.x2 = x2; this.y2 = y2; this.team = team; this.t = 0; this.life = 0.12; this.alive = true; }
  update(dt) { this.t += dt; if (this.t >= this.life) this.alive = false; }
}
