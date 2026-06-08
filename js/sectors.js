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
  }

  // pixel bounds
  get px() { return this.rect.x * CFG.TILE; }
  get py() { return this.rect.y * CFG.TILE; }
  get pw() { return this.rect.w * CFG.TILE; }
  get ph() { return this.rect.h * CFG.TILE; }

  /* The capture trigger: a crewed combat unit of an opposing team touching
   * the flag flips the sector to its colour. No health bar — pure switch. */
  setOwner(team) {
    if (this.owner === team) return;
    this.owner = team;
    this.flash = 0.6;
    // All factories here switch production to the new owner and DISCARD any
    // progress (a 90%-built enemy tank is lost; new owner starts at 0%).
    for (const f of this.factories) f.onOwnerChanged();
  }
}

const Sectors = {
  /* Scan every flag for a capturing unit. Runs each frame. */
  checkCaptures() {
    for (const sec of G.sectors) {
      if (sec.flash > 0) sec.flash -= G.dt;
      const flag = sec.flag;
      if (!flag) continue;
      // find the nearest crewed combat unit on the flag
      for (const u of G.units) {
        if (!u.alive || !u.crewed) continue;
        if (u.team === TEAM.NEUTRAL) continue;
        if (u.team === sec.owner) continue;
        if (Util.dist(u.x, u.y, flag.x, flag.y) <= CFG.FLAG_CAPTURE_RADIUS) {
          sec.setOwner(u.team);
          break;
        }
      }
    }
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
