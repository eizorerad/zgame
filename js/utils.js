/* =========================================================================
 * utils.js — small math/helpers shared across modules
 * ========================================================================= */

const Util = {
  dist(ax, ay, bx, by) {
    const dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  },

  dist2(ax, ay, bx, by) {
    const dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
  },

  clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; },

  rand(lo, hi) { return lo + Math.random() * (hi - lo); },
  randInt(lo, hi) { return Math.floor(Util.rand(lo, hi + 1)); },
  pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; },
  chance(p) { return Math.random() < p; },

  // pixel -> tile coords
  tx(px) { return Math.floor(px / CFG.TILE); },
  ty(py) { return Math.floor(py / CFG.TILE); },
  // tile -> pixel center
  cx(tileX) { return tileX * CFG.TILE + CFG.TILE / 2; },
  cy(tileY) { return tileY * CFG.TILE + CFG.TILE / 2; },

  fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  },

  // unique id generator
  _id: 0,
  uid() { return ++Util._id; },

  // move a value toward target by at most step
  approach(cur, target, step) {
    if (cur < target) return Math.min(cur + step, target);
    if (cur > target) return Math.max(cur - step, target);
    return cur;
  },
};
