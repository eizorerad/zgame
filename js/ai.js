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
    if (u.commandAttack && !u.commandAttack.alive) { u.commandAttack = null; u._nextQueued(); }

    const scanR = u.holdPosition ? u.range : u.aggro;

    // leash: drop an auto-target that strayed too far
    if (u.target) {
      if (!u.target.alive ||
          Util.dist(u.x, u.y, u.target.x, u.target.y) > u.aggro * 1.7) {
        u.target = null;
      }
    }

    // acquire: best counter-weighted enemy inside the scan radius
    if (!u.target) {
      const foe = G.nearestEnemyTarget(u.x, u.y, u.team, scanR, u.dtype);
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
 *
 * Priorities each tick:
 *   1. defend own sectors that are being captured (send nearby units back)
 *   2. crew abandoned machines
 *   3. grab NEUTRAL flags with lone units (cheap economy, as before)
 *   4. assault ENEMY territory in SQUADS: idle units gather at a staging
 *      point, and once enough have massed they attack-move together —
 *      waves instead of a dribble of single units.
 * Production reacts to the player's army composition.
 * ---------------------------------------------------------------------- */
class Commander {
  constructor(team) {
    this.team = team;
    this.tick = 0;
    this.prodTick = 0;
    this.robotCycle = ["grunt", "grunt", "bazooka", "psycho", "sniper", "grunt", "pyro", "bazooka"];
    this.robotIdx = 0;
    this.squad = null;          // { ids:Set, state:"gather"|"push", x,y, started }
    this.squadSize = 6;         // grows a little over the match
  }

  update(dt) {
    this.tick -= dt;
    this.prodTick -= dt;
    this.manaTick = (this.manaTick || 0) - dt;
    if (this.prodTick <= 0) { this.prodTick = 5; this._manageProduction(); }
    if (this.tick <= 0) { this.tick = 1.2; this._command(); }
    if (this.manaTick <= 0) { this.manaTick = 4; this._spendMana(); }
  }

  // Spend banked mana: upgrades when comfortable, emergency units when behind.
  _spendMana() {
    const mana = G.mana[this.team], enemy = enemyOf(this.team);
    const behind = G.unitCount(this.team) < G.unitCount(enemy) - 2
                || Sectors.countOwned(this.team) < Sectors.countOwned(enemy);
    if (behind && mana >= G.manaCost("light")) {
      // reinforce: a couple of cheap grunts or a tank, depending on the gap
      if (G.unitCount(this.team) < G.unitCount(enemy) - 4 && mana >= G.manaCost("medium")) G.instantBuild(this.team, "medium");
      else { G.instantBuild(this.team, "grunt"); G.instantBuild(this.team, "grunt"); }
      return;
    }
    if (mana >= 140) {                          // bank is healthy -> invest in upgrades
      const cats = ["vehAtk", "infAtk", "vehDef", "infDef"];
      for (const c of cats) if (G.upgrades[this.team][c] < CFG.UPGRADE_MAX) { G.buyUpgrade(this.team, c); break; }
    }
  }

  // What is the player fielding? Returns the vehicle share of their army.
  _enemyVehicleShare() {
    const enemy = enemyOf(this.team);
    let inf = 0, veh = 0;
    for (const u of G.units) {
      if (!u.alive || u.team !== enemy || !u.crewed) continue;
      if (u.kind === "machine" && !u.immobile) veh++; else if (u.kind === "infantry") inf++;
    }
    const total = inf + veh;
    return total ? veh / total : 0;
  }

  _manageProduction() {
    const owners = Sectors.countOwned(this.team);
    const vehShare = this._enemyVehicleShare();
    const now = G.time;
    for (const sec of G.sectors) {
      if (sec.owner !== this.team) continue;
      for (const f of sec.factories) {
        // Each factory keeps a STABLE preference so we don't reset its
        // in-progress build every planning tick, but re-reads the player's
        // army composition every ~20s and counter-builds.
        const stale = !f._aiType || (now - (f._aiPicked || 0)) > 20;
        if (f.ftype === "robot") {
          if (stale) {
            f._aiPicked = now;
            // tank-heavy player -> anti-armour squads; infantry-heavy -> flame/brawl
            f._aiType = vehShare > 0.5 ? Util.pick(["bazooka", "bazooka", "sniper", "grunt"])
                      : vehShare > 0.25 ? this.robotCycle[(this.robotIdx++) % this.robotCycle.length]
                      : Util.pick(["pyro", "psycho", "grunt", "grunt", "sniper"]);
          }
          if (f.queueKey !== f._aiType && f.buildFraction() < 0.25) f.setQueue(f._aiType);
        } else if (f.ftype === "vehicle") {
          if (stale) {
            f._aiPicked = now;
            const r = Math.random();
            // infantry-heavy player -> jeeps/light cannon; tank-heavy -> rockets/mediums
            f._aiType = vehShare > 0.45
                      ? (owners >= 3 ? (r < 0.45 ? "rocket" : r < 0.8 ? "medium" : "light") : (r < 0.5 ? "rocket" : "light"))
                      : owners >= 4 ? (r < 0.4 ? "medium" : r < 0.7 ? "light" : "jeep")
                      : owners >= 2 ? (r < 0.45 ? "light" : r < 0.75 ? "jeep" : "rocket")
                      : (r < 0.6 ? "jeep" : "light");
          }
          if (f.queueKey !== f._aiType && f.buildFraction() < 0.25) f.setQueue(f._aiType);
        } else if (f.ftype === "gun") {
          f.setQueue("pillbox");
        }
      }
    }
  }

  _command() {
    const myUnits = G.units.filter(u => u.alive && u.team === this.team && u.crewed);
    const enemy = enemyOf(this.team);

    // 1) DEFEND: a sector of ours is being flipped -> pull nearby units home
    const defended = new Set();
    for (const s of G.sectors) {
      if (s.owner !== this.team || !s.flag) continue;
      if (!(s.capTeam === enemy && s.capProgress > 0.08)) continue;
      let sent = 0;
      const byDist = myUnits
        .filter(u => !u.commandAttack && !u.target && !(u.kind === "machine" && u.immobile))
        .filter(u => !defended.has(u.id))
        .sort((a, b) => Util.dist2(a.x, a.y, s.flag.x, s.flag.y) - Util.dist2(b.x, b.y, s.flag.x, s.flag.y));
      for (const u of byDist) {
        if (sent >= 3) break;
        u.orderAttackMove(s.flag.x, s.flag.y);
        defended.add(u.id);
        if (this.squad) this.squad.ids.delete(u.id);   // defence outranks the squad
        sent++;
      }
    }

    // 2) crew abandoned machines we can reach
    const emptyMachines = G.units.filter(u => u.alive && u.kind === "machine" && !u.driver);
    for (const m of emptyMachines) {
      const inf = this._nearestFreeInfantry(myUnits, m.x, m.y, 260);
      if (inf && !defended.has(inf.id)) { inf.orderMove(m.x, m.y); inf._claimMachine = m.id; }
    }

    // 3) collect truly idle units
    const idle = myUnits.filter(u => {
      if (defended.has(u.id)) return false;
      if (u.commandAttack && u.commandAttack.alive) return false;
      if (u.order === "move" && u.moveGoalX != null && !u.target) return false; // en route
      if (u.target) return false;                                              // fighting
      if (u.kind === "machine" && u.immobile) return false;                    // pillboxes
      const here = Sectors.sectorAt(u.x, u.y);
      if (here && here.flag && here.owner !== this.team) return false;         // mid-capture
      return true;
    });

    // 4) NEUTRAL flags: lone grabs are fine (free economy, no resistance) —
    //    but units already drafted into the assault squad stay with it
    const remaining = [];
    for (const u of idle) {
      if (this.squad && this.squad.ids.has(u.id)) { remaining.push(u); continue; }
      const nf = this._nearestNeutralFlag(u.x, u.y);
      if (nf && Util.chance(0.8)) u.orderMove(nf.x, nf.y);
      else remaining.push(u);
    }

    // 5) ENEMY territory: assault in squads, not a trickle
    this._runSquad(remaining, enemy);
  }

  _runSquad(candidates, enemy) {
    const enemyFort = G.forts.find(f => f.team === enemy && f.alive);
    this.squadSize = Math.min(10, 6 + Math.floor(G.time / 150));   // waves grow over time

    // validate the current squad (drop dead members)
    if (this.squad) {
      for (const id of this.squad.ids)
        if (!G.units.some(u => u.id === id && u.alive && u.crewed && u.team === this.team))
          this.squad.ids.delete(id);
      if (this.squad.ids.size === 0) this.squad = null;
    }

    if (!this.squad) {
      if (!candidates.length) return;
      // stage the new wave at our sector closest to the map centre
      let sx = 0, sy = 0, best = Infinity;
      const cx = G.worldW() / 2, cy = G.worldH() / 2;
      for (const s of G.sectors) {
        if (s.owner !== this.team || !s.flag) continue;
        const d = Util.dist2(s.cx, s.cy, cx, cy);
        if (d < best) { best = d; sx = s.cx; sy = s.cy; }
      }
      if (best === Infinity) { sx = candidates[0].x; sy = candidates[0].y; }
      this.squad = { ids: new Set(), state: "gather", x: sx, y: sy, started: G.time };
    }

    const squad = this.squad;
    const members = G.units.filter(u => squad.ids.has(u.id) && u.alive);

    if (squad.state === "gather") {
      // recruit idle units into the staging area
      for (const u of candidates) {
        if (squad.ids.size >= this.squadSize) break;
        if (!squad.ids.has(u.id)) {
          squad.ids.add(u.id);
          u.orderMove(squad.x + Util.rand(-30, 30), squad.y + Util.rand(-30, 30));
        }
      }
      // launch when massed (or impatient after 45s with at least half a wave)
      const near = members.filter(u => Util.dist(u.x, u.y, squad.x, squad.y) < 130).length;
      const waited = G.time - squad.started;
      if ((squad.ids.size >= this.squadSize && near >= this.squadSize * 0.7) ||
          (waited > 45 && near >= Math.max(3, this.squadSize / 2))) {
        // objective: usually the enemy flag nearest the stage, sometimes the fort
        let tx, ty;
        const ef = this._nearestEnemyFlag(squad.x, squad.y, enemy);
        if (enemyFort && (!ef || Util.chance(0.3))) {
          tx = Util.cx(enemyFort.entry.x); ty = Util.cy(enemyFort.entry.y);
        } else if (ef) { tx = ef.x; ty = ef.y; }
        else return;
        squad.state = "push"; squad.x = tx; squad.y = ty;
        for (const u of members) u.orderAttackMove(tx, ty);
      }
    } else {
      // re-issue the push to members that finished their fight and idled
      for (const u of members) {
        if (!u.target && !(u.moveGoalX != null) && !u.commandAttack) u.orderAttackMove(squad.x, squad.y);
      }
      // wave spent or objective flipped -> plan the next one
      const objective = Sectors.sectorAt(squad.x, squad.y);
      if (members.length <= 1 || (objective && objective.owner === this.team)) this.squad = null;
    }
  }

  _nearestNeutralFlag(x, y) {
    let best = null, bd = Infinity;
    for (const s of G.sectors) {
      if (s.owner !== TEAM.NEUTRAL || !s.flag) continue;
      const d = Util.dist2(x, y, s.flag.x, s.flag.y);
      if (d < bd) { bd = d; best = s.flag; }
    }
    return best;
  }

  _nearestEnemyFlag(x, y, enemy) {
    let best = null, bd = Infinity;
    for (const s of G.sectors) {
      if (s.owner !== enemy || !s.flag) continue;
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
