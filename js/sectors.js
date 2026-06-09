/* =========================================================================
 * sectors.js — territory model.
 *
 * The map is carved into hard-bordered sectors. Each owns exactly one flag
 * and zero or more factories. Territory == production speed:
 *
 *     actualTime = baseTime / (1 + sectorsOwned * SECTOR_SPEED_MULT)
 *
 * Because factories read this every frame, capturing a sector *instantly*
 * recalculates the remaining time on every in-progress build across the
 * whole empire — exactly the Z behaviour.
 *
 * Flag capture is a pure state machine driven by collision:
 *
 *        [ neutral ]
 *         /       \
 *   (red touches) (blue touches)
 *        v           v
 *     [ red ] <---> [ blue ]
 * ========================================================================= */

class Sector {
  constructor(id, tileRect) {
    this.id = id;
    this.rect = tileRect;            // {x,y,w,h} in tiles
    this.owner = TEAM.NEUTRAL;
    this.flag = null;
    this.factories = [];
    this.flash = 0;                  // capture flash timer
    // contested-capture state
    this.capTeam = null;             // team currently filling the meter
    this.capProgress = 0;            // 0..1
    this.contested = false;          // both sides (or owner defending) on point
  }

  // pixel bounds
  get px() { return this.rect.x * CFG.TILE; }
  get py() { return this.rect.y * CFG.TILE; }
  get pw() { return this.rect.w * CFG.TILE; }
  get ph() { return this.rect.h * CFG.TILE; }

  /* Ownership change (after a capture meter completes). All factories here
   * switch production to the new owner and DISCARD any progress — a 90%-built
   * enemy tank is lost; the new owner starts at 0%. */
  setOwner(team) {
    if (this.owner === team) return;
    // defensive comeback: the team that just LOST this sector banks HQ mana
    if (this.owner === TEAM.BLUE || this.owner === TEAM.RED) {
      G.mana[this.owner] = Math.min(CFG.MANA_MAX, G.mana[this.owner] + CFG.MANA_ON_LOSE);
    }
    this.owner = team;
    this.flash = 0.6;
    for (const f of this.factories) f.onOwnerChanged();
  }

  /* Drive the capture meter from who is standing on the flag this frame.
   *   - claiming a NEUTRAL flag fills toward the lone present team
   *   - taking an ENEMY flag first neutralizes it (meter -> neutral), then
   *     a second fill claims it (so it costs ~2x and stops their production
   *     the moment it's neutralized)
   *   - contested (both teams, or owner defending) freezes & slowly bleeds
   *   - an empty point lets a half-finished attempt decay away */
  updateCapture(blue, red, dt) {
    const owner = this.owner;
    const atkBlue = blue && owner !== TEAM.BLUE;
    const atkRed  = red  && owner !== TEAM.RED;
    const ownerDefends = (owner === TEAM.BLUE && blue) || (owner === TEAM.RED && red);

    if ((atkBlue && atkRed) || (ownerDefends && (atkBlue || atkRed))) {
      this.contested = true;
      this._decay(dt * 0.4);          // standoff: meter bleeds slowly, nobody takes it
      return;
    }
    this.contested = false;

    const atk = atkBlue ? TEAM.BLUE : atkRed ? TEAM.RED : null;
    if (!atk) { this._decay(dt); return; }

    if (this.capTeam !== atk) { this.capTeam = atk; this.capProgress = 0; }
    this.capProgress += dt / CFG.CAPTURE_TIME;
    if (this.capProgress >= 1) {
      this.capProgress = 0;
      if (this.owner !== TEAM.NEUTRAL) {
        this.setOwner(TEAM.NEUTRAL);  // phase 1: neutralized — keep capTeam to keep claiming
      } else {
        const t = this.capTeam; this.capTeam = null;
        this.setOwner(t);             // phase 2: claimed
      }
    }
  }

  _decay(dt) {
    if (this.capProgress <= 0) { this.capProgress = 0; this.capTeam = null; return; }
    this.capProgress -= (dt / CFG.CAPTURE_TIME) * CFG.CAPTURE_DECAY;
    if (this.capProgress <= 0) { this.capProgress = 0; this.capTeam = null; }
  }
}

const Sectors = {
  /* Each frame: tally which teams have any presence inside each sector's
   * SQUARE (not just on the flag), then advance that sector's capture meter.
   * Having units anywhere in the square contests/claims it — so a force you
   * can see in the sector always has a chance to take it. */
  checkCaptures() {
    const dt = G.dt;
    for (const s of G.sectors) { s._pBlue = false; s._pRed = false; if (s.flash > 0) s.flash -= dt; }
    for (const u of G.units) {
      if (!u.alive || !u.crewed || u.team === TEAM.NEUTRAL) continue;
      const s = Sectors.sectorAt(u.x, u.y);
      if (!s) continue;
      if (u.team === TEAM.BLUE) s._pBlue = true; else s._pRed = true;
    }
    for (const s of G.sectors) if (s.flag) s.updateCapture(s._pBlue, s._pRed, dt);
  },

  countOwned(team) {
    let n = 0;
    for (const s of G.sectors) if (s.owner === team) n++;
    return n;
  },

  speedMultiplier(team) {
    return 1 + Sectors.countOwned(team) * CFG.SECTOR_SPEED_MULT;
  },

  sectorAt(px, py) {
    const tx = Util.tx(px), ty = Util.ty(py);
    for (const s of G.sectors) {
      if (tx >= s.rect.x && tx < s.rect.x + s.rect.w &&
          ty >= s.rect.y && ty < s.rect.y + s.rect.h) return s;
    }
    return null;
  },
};
