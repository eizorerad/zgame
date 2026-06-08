/* =========================================================================
 * ai.js
 *
 *  UnitAI    : per-unit "dumb robot" finite state machine. Units are
 *              autonomously aggressive — a wide aggro radius makes idle and
 *              even moving units break off to engage anything they see,
 *              UNLESS they are on Hold Position (then they only fire at what
 *              wanders into weapon range).
 *
 *  Commander : the enemy (RED) brain. Sets factory production and throws
 *              units at flags / the player with relentless momentum.
 * ========================================================================= */

const UnitAI = {
  think(u) {
    if (!u.alive) return;
    if (u.kind === "machine" && !u.driver) return;   // empty, inert
    if (u.wallTarget) return;                          // busy clearing a wall

    // explicit player/commander attack order overrides everything
    if (u.commandAttack && u.commandAttack.alive) {
      u.target = u.commandAttack;
      return;
    }
    if (u.commandAttack && !u.commandAttack.alive) u.commandAttack = null;

    const scanR = u.holdPosition ? u.range : u.aggro;

    // leash: drop an auto-target that strayed too far
    if (u.target) {
      if (!u.target.alive ||
          Util.dist(u.x, u.y, u.target.x, u.target.y) > u.aggro * 1.7) {
        u.target = null;
      }
    }

    // acquire: nearest enemy thing inside the scan radius
    if (!u.target) {
      const foe = G.nearestEnemyTarget(u.x, u.y, u.team, scanR);
      if (foe) u.target = foe;
    }

    // hold position never chases: stand and fire only within weapon range
    if (u.holdPosition && u.target &&
        Util.dist(u.x, u.y, u.target.x, u.target.y) > u.range) {
      u.target = null;
    }

    // nothing to fight: resume the last move order if we had one
    if (!u.target && u.moveGoalX != null && !u.holdPosition) {
      const gtx = Util.tx(u.moveGoalX), gty = Util.ty(u.moveGoalY);
      if (u.goalTx !== gtx || u.goalTy !== gty) {
        u._setGoal(u.moveGoalX, u.moveGoalY);
      }
    }
  },
};

/* -------------------------------------------------------------------------
 * Commander — enemy strategic AI (team RED).
 * ---------------------------------------------------------------------- */
class Commander {
  constructor(team) {
    this.team = team;
    this.tick = 0;
    this.prodTick = 0;
    this.robotCycle = ["grunt", "grunt", "psycho", "sniper", "grunt", "pyro"];
    this.robotIdx = 0;
  }

  update(dt) {
    this.tick -= dt;
    this.prodTick -= dt;
    if (this.prodTick <= 0) { this.prodTick = 5; this._manageProduction(); }
    if (this.tick <= 0) { this.tick = 1.2; this._command(); }
  }

  _manageProduction() {
    const owners = Sectors.countOwned(this.team);
    for (const sec of G.sectors) {
      if (sec.owner !== this.team) continue;
      for (const f of sec.factories) {
        // Each factory keeps a STABLE preference so we don't reset its
        // in-progress build every planning tick. Vehicle plants scale up to
        // heavier tanks as territory grows (only changes occasionally).
        if (f.ftype === "robot") {
          if (!f._aiType) f._aiType = this.robotCycle[(this.robotIdx++) % this.robotCycle.length];
          f.setQueue(f._aiType);
        } else if (f.ftype === "vehicle") {
          const want = owners >= 4 ? "medium" : owners >= 2 ? "light" : "jeep";
          if (f.queueKey !== want && f.buildFraction() < 0.25) f.setQueue(want);
        } else if (f.ftype === "gun") {
          f.setQueue("pillbox");
        }
      }
    }
  }

  _command() {
    const myUnits = G.units.filter(u => u.alive && u.team === this.team && u.crewed);
    const enemy = enemyOf(this.team);

    // 1) crew abandoned machines we can reach
    const emptyMachines = G.units.filter(u => u.alive && u.kind === "machine" && !u.driver);
    for (const m of emptyMachines) {
      const inf = this._nearestFreeInfantry(myUnits, m.x, m.y, 260);
      if (inf) { inf.orderMove(m.x, m.y); inf._claimMachine = m.id; }
    }

    // 2) push idle units: capture flags or assault the enemy fort
    const enemyFort = G.forts.find(f => f.team === enemy && f.alive);
    for (const u of myUnits) {
      if (u.commandAttack && u.commandAttack.alive) continue;
      if (u.order === "move" && u.moveGoalX != null && !u.target) continue; // already en route
      if (u.target) continue; // currently fighting

      const flag = this._nearestCapturable(u.x, u.y);
      // momentum: most units rush flags, a fraction assaults the fort directly
      if (flag && (Util.chance(0.7) || !enemyFort)) {
        u.orderMove(flag.x, flag.y);
      } else if (enemyFort) {
        // aim a unit at the fort entry tile — infiltration is a win!
        const ex = Util.cx(enemyFort.entry.x), ey = Util.cy(enemyFort.entry.y);
        u.orderMove(ex, ey);
      }
    }
  }

  _nearestCapturable(x, y) {
    let best = null, bd = Infinity;
    for (const s of G.sectors) {
      if (s.owner === this.team || !s.flag) continue;
      const d = Util.dist2(x, y, s.flag.x, s.flag.y);
      if (d < bd) { bd = d; best = s.flag; }
    }
    return best;
  }

  _nearestFreeInfantry(units, x, y, maxR) {
    let best = null, bd = maxR * maxR;
    for (const u of units) {
      if (u.kind !== "infantry") continue;
      if (u.commandAttack) continue;
      const d = Util.dist2(x, y, u.x, u.y);
      if (d < bd) { bd = d; best = u; }
    }
    return best;
  }
}
