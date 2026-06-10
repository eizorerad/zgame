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
    this.facing = 0;            // turret / aim direction
    this.hullFacing = 0;        // body / movement direction
    this.animClock = 0;         // walk-cycle clock
    this.moving = false;

    // veterancy
    this.kills = 0;
    this.rank = 0;

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
      if (this.stats.transport) this.cargo = [];  // APC passenger bay
    }

    // order / movement
    this.order = "idle";         // idle | move | amove | attack | hold
    this.holdPosition = false;
    this.chase = false;          // true = pursue enemies (attack-move / attack)
    this.attackMove = false;
    this.path = [];              // array of {x,y} tile coords
    this.wpx = null; this.wpy = null;  // current waypoint pixel target
    this.goalTx = null; this.goalTy = null;
    this.target = null;          // entity being attacked (effective)
    this.commandAttack = null;   // explicit player/AI attack order
    this.moveGoalX = null;       // remembered move destination (resume after combat)
    this.moveGoalY = null;
    this.wallTarget = null;      // {tx,ty} wall we're clearing
    this.repathTimer = 0;
    this.orderQueue = [];        // shift-queued follow-up orders
    this.boardTarget = null;     // friendly APC this infantry is boarding
    this.speedCap = null;        // group move: match the slowest member
    this.vx = 0; this.vy = 0;    // measured velocity (ballistic lead prediction)

    // combat
    this.cooldown = 0;
    this.aggro = this.stats.aggro || CFG.DEFAULT_AGGRO;
    this.recoil = 0;             // turret recoil timer (visual)
    this.smokeTimer = 0;         // damaged-vehicle smoke emitter
    this._snipeHits = 0;         // sniper: hits landed on crewed vehicles
  }

  get team() {
    if (this.kind === "machine") return this.driver ? this.driver.team : TEAM.NEUTRAL;
    return this._team;
  }
  set team(t) { this._team = t; }

  get radius() { return this.stats.radius * CFG.UNIT_SCALE; }
  get speed() { return (this.kind === "machine" && this.immobile ? 0 : this.stats.speed) * CFG.SPEED_SCALE; }
  get crewed() { return this.kind === "infantry" || !!this.driver; }

  // ---- veterancy- and upgrade-scaled combat stats ----
  get range() { return this.stats.range * (1 + this.rank * VET.rangePerRank); }
  get dmg() {
    const up = G.upgrades && G.upgrades[this.team];
    const lvl = up ? (this.kind === "infantry" ? up.infAtk : up.vehAtk) : 0;
    return this.stats.dmg * (1 + this.rank * VET.dmgPerRank) * (1 + lvl * CFG.UPGRADE_STEP);
  }
  get fireCooldown() { return this.stats.cooldown * (1 + this.rank * VET.cooldownPerRank); }
  get cls() { return this.stats.cls; }          // armour class (how it takes hits)
  get dtype() { return this.stats.dtype; }       // damage type (what its weapon deals)

  isVehicle() { return this.kind === "machine" && !this.immobile; }
  isGun() { return this.kind === "machine" && this.immobile; }
  isSniper() { return this.kind === "infantry" && this.typeKey === "sniper"; }

  gainKill() {
    this.kills++;
    let r = 0;
    for (let i = VET.thresholds.length - 1; i >= 0; i--) {
      if (this.kills >= VET.thresholds[i]) { r = i; break; }
    }
    if (r > this.rank) {
      this.rank = r;
      // promotions restore and grow the unit's durability
      if (this.kind === "infantry") {
        const nm = this.stats.hp * (1 + r * VET.hpPerRank);
        this.hp += (nm - this.maxHp); this.maxHp = nm;
      } else {
        const nm = this.stats.armour * (1 + r * VET.hpPerRank);
        this.armour += (nm - this.maxArmour); this.maxArmour = nm;
      }
      G.fx.push(new RankUp(this.x, this.y));
    }
  }

  /* ---- orders -------------------------------------------------------- */
  // plain move: head to the point, "go through" — fire at anything that comes
  // into weapon range while passing, but never chase off-course.
  orderMove(px, py, speedCap) {
    this.order = "move";
    this.target = null; this.commandAttack = null; this.boardTarget = null;
    this.holdPosition = false; this.chase = false; this.attackMove = false;
    this.speedCap = speedCap || null;
    this.moveGoalX = px; this.moveGoalY = py;
    this._setGoal(px, py);
  }

  // attack-move: advance to the point AND break off to hunt any enemy seen.
  orderAttackMove(px, py, speedCap) {
    this.order = "amove";
    this.target = null; this.commandAttack = null; this.boardTarget = null;
    this.holdPosition = false; this.chase = true; this.attackMove = true;
    this.speedCap = speedCap || null;
    this.moveGoalX = px; this.moveGoalY = py;
    this._setGoal(px, py);
  }

  // attack a specific target: pursue it to the death.
  orderAttack(entity) {
    this.order = "attack";
    this.commandAttack = entity;
    this.target = entity;
    this.holdPosition = false; this.chase = true; this.attackMove = false;
    this.boardTarget = null; this.speedCap = null;
    this.wallTarget = null;
    this.moveGoalX = this.moveGoalY = null;
  }

  // walk to a friendly APC and climb in (completed in update())
  orderBoard(apc) {
    this.order = "board";
    this.target = null; this.commandAttack = null;
    this.holdPosition = false; this.chase = false; this.attackMove = false;
    this.boardTarget = apc; this.speedCap = null;
    this.moveGoalX = apc.x; this.moveGoalY = apc.y;
    this._setGoal(apc.x, apc.y);
  }

  orderHold() {
    this.holdPosition = true;
    this.order = "hold";
    this.chase = false; this.attackMove = false; this.boardTarget = null;
    this.path = []; this.wpx = this.wpy = null;
    this.target = null; this.commandAttack = null;
    this.moveGoalX = this.moveGoalY = null;
    this.orderQueue.length = 0;
  }

  // user stop: drop everything, including any queued follow-up orders
  stop() {
    this._halt();
    this.orderQueue.length = 0;
  }

  _halt() {
    this.order = "idle";
    this.chase = false; this.attackMove = false; this.boardTarget = null;
    this.path = []; this.wpx = this.wpy = null;
    this.goalTx = this.goalTy = null;
    this.moveGoalX = this.moveGoalY = null;
    this.speedCap = null;
  }

  // reached a destination: run the next queued order, if any
  _arrive() {
    this._halt();
    this._nextQueued();
  }

  // append a follow-up order (shift-click); executes when the current one ends
  queueOrder(o) { this.orderQueue.push(o); }

  _nextQueued() {
    const o = this.orderQueue.shift();
    if (!o) return false;
    if (o.kind === "amove") this.orderAttackMove(o.x, o.y, o.speedCap);
    else if (o.kind === "attack" && o.entity && o.entity.alive) this.orderAttack(o.entity);
    else if (o.kind === "board" && o.entity && o.entity.alive) this.orderBoard(o.entity);
    else if (o.kind === "move") this.orderMove(o.x, o.y, o.speedCap);
    else return this._nextQueued();      // stale entry — try the next one
    return true;
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
    if (this.recoil > 0) this.recoil -= dt;
    this.moving = false;
    this.vx = 0; this.vy = 0;

    // Empty machines just sit there waiting to be crewed.
    if (this.kind === "machine" && !this.driver) return;

    // Damaged vehicles trail smoke (grey when hurt, black + embers when dying)
    if (this.kind === "machine" && !this.immobile && this.armour < this.maxArmour * 0.5) {
      this.smokeTimer -= dt;
      if (this.smokeTimer <= 0) {
        const critical = this.armour < this.maxArmour * 0.25;
        this.smokeTimer = critical ? 0.10 : 0.22;
        G.fx.push(new SmokePuff(this.x + Util.rand(-3, 3), this.y + Util.rand(-3, 3), critical));
      }
    }

    // Boarding a friendly APC: walk up, climb in (this unit leaves the world).
    if (this.boardTarget) {
      const a = this.boardTarget;
      if (!a.alive || !a.driver || a.team !== this.team || a.cargo.length >= a.stats.transport) {
        this.boardTarget = null; this._arrive();
      } else if (Util.dist(this.x, this.y, a.x, a.y) <= this.radius + a.radius + 3) {
        a.cargo.push({ typeKey: this.typeKey, team: this.team, hp: this.hp, maxHp: this.maxHp, kills: this.kills, rank: this.rank });
        this.alive = false;
        Sound.playAt("crew", a.x, a.y);
        return;
      } else {
        // APCs can move — refresh the goal if it drove off
        if (Util.dist(a.x, a.y, this.moveGoalX, this.moveGoalY) > CFG.TILE * 2) {
          this.moveGoalX = a.x; this.moveGoalY = a.y; this._setGoal(a.x, a.y);
        }
        this._followPath(dt);
        return;
      }
    }

    // Attacking a wall to clear a path.
    if (this.wallTarget) {
      this._fightWall(dt);
      this._maybeRepair(dt);
      return;
    }

    const tgt = this.target;
    const pursue = this.chase || (this.commandAttack && this.commandAttack.alive);

    // Weapons with a minimum range (rocket artillery) cannot fire point-blank
    // — get inside that ring and they are helpless. That's their weakness.
    const minR = this.stats.minRange || 0;

    // Hold position: stand still, fire only at what enters weapon range.
    if (this.holdPosition) {
      if (tgt && tgt.alive) {
        const d = Util.dist(this.x, this.y, tgt.x, tgt.y);
        if (d <= this.range && d >= minR) { this.faceTo(tgt.x, tgt.y); this._fire(tgt); }
      }
      return;
    }

    // Pursue mode (attack / attack-move): chase the target, fire when in range
    // AND in sight — without line-of-sight keep closing in until it clears.
    if (pursue && tgt && tgt.alive) {
      const d = Util.dist(this.x, this.y, tgt.x, tgt.y);
      if (d <= this.range && this._canHit(tgt)) {
        this.faceTo(tgt.x, tgt.y);
        if (d >= minR) this._fire(tgt);     // too close -> can't engage
        return;
      }
      if (this.goalTx !== Util.tx(tgt.x) || this.goalTy !== Util.ty(tgt.y)) this._setGoal(tgt.x, tgt.y);
      this._followPath(dt);
      return;
    }

    // Go-through move (or idle): keep heading to the goal, only firing at a
    // target that is already in weapon range — never chase off-course.
    if (tgt && tgt.alive) {
      const d = Util.dist(this.x, this.y, tgt.x, tgt.y);
      if (d <= this.range && d >= minR && this._canHit(tgt)) { this.faceTo(tgt.x, tgt.y); this._fire(tgt); }
    }
    this._followPath(dt);
    this._maybeRepair(dt);
  }

  // direct-fire weapons need line-of-sight; rockets arc over obstacles
  _canHit(tgt) {
    if (this.dtype === "rocket") return true;
    return G.hasLOS(this.x, this.y, tgt.x, tgt.y);
  }

  _followPath(dt) {
    if (this.wpx == null) return;
    const dx = this.wpx - this.x, dy = this.wpy - this.y;
    const d = Math.hypot(dx, dy);
    if (d < 2) { this.advanceWaypoint(); return; }
    // terrain modifies ground speed (roads fast, scrub slow); a group move
    // caps everyone at the slowest member so formations arrive together
    const terr = G.terrainAt(this.x, this.y);
    const base = this.speedCap ? Math.min(this.speed, this.speedCap) : this.speed;
    const sp = base * (TERRAIN_SPEED[terr] ?? 1) * dt;
    const nx = this.x + (dx / d) * sp;
    const ny = this.y + (dy / d) * sp;
    this.hullFacing = Math.atan2(dy, dx);
    if (!this.target) this.facing = this.hullFacing;   // turret rests forward
    // block on freshly-changed walls
    if (G.tilePassable(Util.tx(nx), Util.ty(ny))) {
      this.vx = (nx - this.x) / dt; this.vy = (ny - this.y) / dt;
      this.x = nx; this.y = ny;
      this.moving = true;
      this.animClock += dt * 9;
      if (this.isVehicle()) { this._crush(); this._layTracks(sp); }
    } else {
      this.recomputePath();
    }
    if (this.path.length === 0 && Math.hypot(this.wpx - this.x, this.wpy - this.y) < 2) {
      this._arrive();
    }
  }

  // moving vehicles leave fading tread marks on soft ground
  _layTracks(step) {
    this._trackDist = (this._trackDist || 0) + step;
    if (this._trackDist < 7) return;
    this._trackDist = 0;
    const terr = G.terrainAt(this.x, this.y);
    if (terr !== TERR.SAND && terr !== TERR.SCRUB) return;
    G.addTrack(this.x, this.y, this.hullFacing, this.radius * 0.55);
  }

  // tanks/jeeps flatten enemy infantry they drive over
  _crush() {
    for (const o of G.units) {
      if (!o.alive || o.kind !== "infantry") continue;
      if (o.team === this.team) continue;
      if (Util.dist(this.x, this.y, o.x, o.y) <= this.radius + o.radius - 1) {
        o.applyDamage(CFG.CRUSH_DMG, this, false);
        G.fx.push(new Spark(o.x, o.y, "#7a1010"));
      }
    }
  }

  _maybeRepair(dt) {
    if (this.target || this.cooldown > this.stats.cooldown * 0.5) return;
    if (!G.nearFriendlyDepot(this)) return;
    if (this.kind === "infantry") {
      if (this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + CFG.REPAIR_RATE * dt);
    } else if (this.driver) {
      if (this.armour < this.maxArmour) this.armour = Math.min(this.maxArmour, this.armour + CFG.REPAIR_RATE * dt);
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
        this.cooldown = this.fireCooldown;
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
    this.cooldown = this.fireCooldown;
    // sniper crew kills are deterministic: every Nth hit on a crewed vehicle
    // drops the driver (veterans need one hit fewer)
    let sniper = false;
    if (this.isSniper() && target.kind === "machine" && target.driver) {
      const every = Math.max(2, CFG.SNIPE_CREW_EVERY - (this.rank >= 2 ? 1 : 0));
      this._snipeHits++;
      sniper = this._snipeHits % every === 0;
    }
    G.spawnProjectile(this, target, sniper);
    G.fx.push(new Muzzle(this.x, this.y, this.facing, this.team));
    if (this.dtype === "cannon" || this.dtype === "rocket") this.recoil = 0.12;
    Sound.playAt("shoot_" + this.dtype, this.x, this.y);
  }

  faceTo(px, py) { this.facing = Math.atan2(py - this.y, px - this.x); }

  /* ---- damage -------------------------------------------------------- */
  applyDamage(amount, attacker, sniperKill) {
    if (!this.alive) return;
    // counter system: damage-type vs this unit's armour class
    const dty = attacker && attacker.dtype;
    if (dty && DMG_MULT[dty]) amount *= (DMG_MULT[dty][this.cls] ?? 1);
    // defence upgrades reduce incoming damage
    const up = G.upgrades && G.upgrades[this.team];
    if (up) { const lvl = this.kind === "infantry" ? up.infDef : up.vehDef; amount = amount / (1 + lvl * CFG.UPGRADE_STEP); }
    // an attack on the player's units pings the minimap
    if (this.team === G.player && attacker && attacker.team !== G.player) G.ping(this.x, this.y);
    if (this.kind === "infantry") {
      this.hp -= amount;
      if (this.hp <= 0) this.die(attacker);
      return;
    }
    // machine
    if (sniperKill && this.driver) {
      // Sniper bypasses armour and kills the driver. Machine survives, empty.
      this.ejectDriver(true);
      G.fx.push(new Spark(this.x, this.y, "#fff"));
      Sound.playAt("crewkill", this.x, this.y);
      if (attacker && attacker.gainKill) attacker.gainKill();   // crew kill counts
      return;
    }
    this.armour -= amount;
    if (this.armour <= 0) this.die(attacker);
  }

  ejectDriver(killed) {
    if (this.driver) {
      this.driver = null;        // becomes neutral & inert
      this.order = "idle";
      this.path = []; this.wpx = this.wpy = null;
      this.target = null; this.selected = false;
      this.orderQueue.length = 0;
      // passengers bail out around the stalled vehicle (keeping their team)
      if (this.cargo && this.cargo.length) {
        for (const c of this.cargo) {
          const s = G.freeSpotNear(this.x + Util.rand(-14, 14), this.y + Util.rand(-14, 14));
          const u = new Unit("infantry", c.typeKey, c.team, s.x, s.y);
          u.hp = c.hp; u.maxHp = c.maxHp; u.kills = c.kills; u.rank = c.rank;
          G.units.push(u);
        }
        this.cargo.length = 0;
      }
    }
  }

  die(attacker) {
    this.alive = false;
    // a destroyed transport takes its passengers with it
    const cargoLost = this.cargo ? this.cargo.length : 0;
    const size = this.kind === "machine" ? 18 + cargoLost * 3 : 9;
    if (this.kind === "infantry" && attacker) G.addCorpse(this);
    G.fx.push(new Explosion(this.x, this.y, size));
    if (attacker && attacker.alive && attacker.gainKill) attacker.gainKill();
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
    if (G.atPopCap(this.team)) return;          // hold production at the population cap
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
    // the HQ also trains a chosen unit over time
    this.trainKey = "grunt";
    this.trainProgress = 0;
    this.rally = null;
  }

  update(dt) {
    if (!this.alive) return;
    // automated turret
    if (this.turretCd > 0) this.turretCd -= dt;
    if (this.turretCd <= 0) {
      const foe = G.nearestEnemyUnit(this.x, this.y, this.team, CFG.FORT_TURRET_RANGE);
      if (foe) {
        this.turretCd = CFG.FORT_TURRET_COOLDOWN;
        G.fx.push(new Tracer(this.x, this.y, foe.x, foe.y, this.team));
        foe.applyDamage(CFG.FORT_TURRET_DMG, this, false);
      }
    }
    // time-based training of the selected unit (paused at the population cap)
    if (this.trainKey && !G.atPopCap(this.team)) {
      this.trainProgress += dt;
      if (this.trainProgress >= G.actualBuildTime(G.baseTimeOf(this.trainKey), this.team)) {
        this.trainProgress = 0;
        this.spawn(this.trainKey);
      }
    }
  }

  trainFraction() {
    return Util.clamp(this.trainProgress / G.actualBuildTime(G.baseTimeOf(this.trainKey), this.team), 0, 1);
  }

  setTrain(key) { if (this.trainKey !== key) { this.trainKey = key; this.trainProgress = 0; } }

  // spawn a unit at the HQ (used by training and by instant mana-builds)
  spawn(typeKey) {
    const spot = G.freeSpotNear(this.x, this.y + this.h / 2 + CFG.TILE);
    const kind = G.kindOf(typeKey);
    const u = new Unit(kind, typeKey, this.team, spot.x, spot.y);
    G.units.push(u);
    if (this.rally) u.orderMove(this.rally.x, this.rally.y);
    return u;
  }

  applyDamage(amount) {
    this.hp -= amount;
    if (this.hp <= 0) { this.hp = 0; this.alive = false; }
  }
}

/* -------------------------------------------------------------------------
 * Projectile — delivers damage in one of two ways:
 *
 *   HOMING    (bullet / flame / snipe): tracks the target and always connects
 *             — small-arms fire is an exchange of stats, as before.
 *   BALLISTIC (cannon / rocket): aimed at a PREDICTED POINT with a little
 *             scatter. The shell flies there and explodes — fast units can
 *             dodge, clumps eat splash, and friendly fire is real. Rockets
 *             arc visually and over obstacles; cannons need line-of-sight.
 * ---------------------------------------------------------------------- */
class Projectile {
  constructor(attacker, target, sniper) {
    this.x = attacker.x; this.y = attacker.y;
    this.team = attacker.team;
    this.attacker = attacker;
    this.target = target;
    this.dmg = attacker.dmg !== undefined ? attacker.dmg : attacker.stats.dmg;
    this.sniper = sniper;
    this.dtype = attacker.dtype;
    this.speed = sniper ? CFG.PROJ_SPEED.snipe : (CFG.PROJ_SPEED[this.dtype] || 320);
    this.alive = true;
    this.tx = target.x; this.ty = target.y;

    this.ballistic = !sniper && !target.isWall && (this.dtype === "cannon" || this.dtype === "rocket");
    if (this.ballistic) {
      // lead the target by its current velocity, then add aim scatter
      const d0 = Util.dist(this.x, this.y, target.x, target.y);
      const eta = d0 / this.speed;
      let ax = target.x + (target.vx || 0) * eta;
      let ay = target.y + (target.vy || 0) * eta;
      const err = d0 * CFG.BALLISTIC_SCATTER * (this.dtype === "rocket" ? 1.5 : 1);
      const a = Util.rand(0, Math.PI * 2), r = Util.rand(0, err);
      this.tx = ax + Math.cos(a) * r; this.ty = ay + Math.sin(a) * r;
      this.total = Math.max(1, Util.dist(this.x, this.y, this.tx, this.ty));
      this.traveled = 0;
      this.arc = this.dtype === "rocket";   // drawn with a parabolic height
      this._trail = 0;
    }
  }

  // visual height of an arcing rocket at its current progress
  arcHeight() {
    if (!this.arc) return 0;
    const p = Util.clamp(this.traveled / this.total, 0, 1);
    return Math.sin(p * Math.PI) * this.total * 0.16;
  }

  update(dt) {
    const t = this.target;
    // homing shots track a live target; ballistic shots fly to a fixed point
    if (!this.ballistic && t && t.alive !== false && !t.isWall) { this.tx = t.x; this.ty = t.y; }
    const dx = this.tx - this.x, dy = this.ty - this.y;
    const d = Math.hypot(dx, dy);
    const step = this.speed * dt;
    if (this.ballistic) {
      this.traveled += step;
      if (this.arc) {
        this._trail += dt;
        if (this._trail > 0.04) { this._trail = 0; G.fx.push(new SmokePuff(this.x, this.y - this.arcHeight(), false, 0.4)); }
      }
    }
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
    if (this.ballistic) {
      // explode at the impact point: full damage at the centre falling off to
      // the edge; friends in the blast take CFG.SPLASH_FF of it
      const sp = SPLASH[this.dtype] || { r: 16 };
      G.splashAt(this.tx, this.ty, sp.r, this.dmg, this.attacker);
      G.fx.push(new Explosion(this.tx, this.ty, this.dtype === "rocket" ? 10 : 7));
      return;
    }
    if (t && t.alive) {
      t.applyDamage(this.dmg, this.attacker, this.sniper);
      G.fx.push(new Spark(t.x, t.y, this.sniper ? "#fff" : "#ffcf5b"));
    }
  }
}

/* ---- lightweight visual effects ---------------------------------------- */
/* A chunky Z-style explosion: white flash -> orange fireball -> grey smoke,
 * with metal/ember debris that launches outward, arcs under gravity and
 * tumbles, plus a scorch decal left on the ground. */
class Explosion {
  constructor(x, y, size) {
    this.x = x; this.y = y; this.size = size;
    this.t = 0; this.alive = true;
    this.fbDur = 0.30 + size * 0.006;          // fireball duration
    this.shock = size >= 14;                    // big blasts get a shockwave ring

    // fireball puffs (offset blobs so it's lumpy, not a clean circle)
    this.puffs = [];
    const np = Math.max(3, Math.round(size / 3));
    for (let i = 0; i < np; i++) {
      const a = Math.random() * 7, r = Math.random() * size * 0.45;
      this.puffs.push({ ox: Math.cos(a) * r, oy: Math.sin(a) * r, r: size * (0.4 + Math.random() * 0.55), delay: Math.random() * 0.10 });
    }

    // flying debris
    this.debris = [];
    const nd = Math.max(6, Math.round(size * 1.0));
    const chunk = ["#2b2b2b", "#454545", "#5a5246", "#6b5a3a", "#1c1c1c"];
    for (let i = 0; i < nd; i++) {
      const a = Math.random() * 7, sp = size * (2.2 + Math.random() * 5);
      const hot = Math.random() < 0.4;
      this.debris.push({
        x: 0, y: 0,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - size * (1.0 + Math.random()), // biased upward
        g: 150 + Math.random() * 90, fric: 1.4 + Math.random(),
        t: 0, life: 0.5 + Math.random() * 0.7,
        s: 1 + Math.random() * 2.2, rot: Math.random() * 7, spin: (Math.random() - 0.5) * 12,
        hot, c: hot ? null : chunk[(Math.random() * chunk.length) | 0],
      });
    }

    // rising smoke
    this.smoke = [];
    const ns = Math.max(2, Math.round(size / 4));
    for (let i = 0; i < ns; i++)
      this.smoke.push({ ox: (Math.random() - 0.5) * size * 0.7, r: size * (0.35 + Math.random() * 0.3), rise: 12 + Math.random() * 26, delay: 0.06 + Math.random() * 0.22, life: 0.8 + Math.random() * 0.7 });

    this.maxLife = 1.5 + size * 0.02;
    G.scorch.push({ x, y, r: size * 0.7, t: 0, life: 7 });
    Sound.playAt("explosion", x, y, size * 0.5);
  }

  update(dt) {
    this.t += dt;
    for (const d of this.debris) {
      if (d.t >= d.life) continue;
      d.t += dt;
      d.vy += d.g * dt;
      d.vx -= d.vx * d.fric * dt;
      d.x += d.vx * dt; d.y += d.vy * dt;
      d.rot += d.spin * dt;
    }
    if (this.t >= this.maxLife) this.alive = false;
  }
}
class Spark {
  constructor(x, y, c) { this.x = x; this.y = y; this.c = c; this.t = 0; this.life = 0.18; this.alive = true; }
  update(dt) { this.t += dt; if (this.t >= this.life) this.alive = false; }
}
class Tracer {
  constructor(x1, y1, x2, y2, team) { this.x1 = x1; this.y1 = y1; this.x2 = x2; this.y2 = y2; this.team = team; this.t = 0; this.life = 0.12; this.alive = true; }
  update(dt) { this.t += dt; if (this.t >= this.life) this.alive = false; }
}
class Muzzle {
  constructor(x, y, ang, team) { this.x = x + Math.cos(ang) * 8; this.y = y + Math.sin(ang) * 8; this.ang = ang; this.team = team; this.t = 0; this.life = 0.07; this.alive = true; }
  update(dt) { this.t += dt; if (this.t >= this.life) this.alive = false; }
}
class RankUp {
  constructor(x, y) { this.x = x; this.y = y; this.t = 0; this.life = 0.8; this.alive = true; }
  update(dt) { this.t += dt; this.y -= dt * 12; if (this.t >= this.life) this.alive = false; }
}
// animated marker drawn where the player issues an order
class CommandMarker {
  constructor(x, y, kind) { this.x = x; this.y = y; this.kind = kind; this.t = 0; this.life = 0.6; this.alive = true; }
  update(dt) { this.t += dt; if (this.t >= this.life) this.alive = false; }
}
// a single rising smoke puff (damaged vehicles, rocket trails)
class SmokePuff {
  constructor(x, y, dark, scale = 1) {
    this.x = x; this.y = y; this.dark = dark; this.scale = scale;
    this.t = 0; this.life = dark ? 1.0 : 0.8; this.alive = true;
    this.drift = Util.rand(-4, 4);
  }
  update(dt) { this.t += dt; this.y -= dt * 14; this.x += this.drift * dt; if (this.t >= this.life) this.alive = false; }
}
// floating combat text ("+45 mana", "CREW KILLED")
class FloatText {
  constructor(x, y, text, color) {
    this.x = x; this.y = y; this.text = text; this.color = color;
    this.t = 0; this.life = 1.4; this.alive = true;
  }
  update(dt) { this.t += dt; this.y -= dt * 14; if (this.t >= this.life) this.alive = false; }
}
