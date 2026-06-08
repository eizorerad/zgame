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

/* =========================================================================
 * PX — pixel-art drawing toolkit.
 * Canvas path fills always anti-alias, so to keep a crisp retro look every
 * curve/diagonal is composed from grid-aligned fillRect blocks instead.
 * `pix` is the block size (2 = chunky). Everything snaps to a global grid so
 * all shapes share the same pixel lattice.
 * ========================================================================= */
const PX = {
  fillCircle(ctx, cx, cy, r, color, pix = 2) {
    ctx.fillStyle = color;
    const r2 = r * r;
    const x0 = Math.floor((cx - r) / pix) * pix, x1 = Math.ceil((cx + r) / pix) * pix;
    const y0 = Math.floor((cy - r) / pix) * pix, y1 = Math.ceil((cy + r) / pix) * pix;
    for (let y = y0; y < y1; y += pix)
      for (let x = x0; x < x1; x += pix) {
        const dx = x + pix / 2 - cx, dy = y + pix / 2 - cy;
        if (dx * dx + dy * dy <= r2) ctx.fillRect(x, y, pix, pix);
      }
  },

  fillOval(ctx, cx, cy, rx, ry, color, pix = 2) {
    ctx.fillStyle = color;
    const x0 = Math.floor((cx - rx) / pix) * pix, x1 = Math.ceil((cx + rx) / pix) * pix;
    const y0 = Math.floor((cy - ry) / pix) * pix, y1 = Math.ceil((cy + ry) / pix) * pix;
    for (let y = y0; y < y1; y += pix)
      for (let x = x0; x < x1; x += pix) {
        const dx = (x + pix / 2 - cx) / rx, dy = (y + pix / 2 - cy) / ry;
        if (dx * dx + dy * dy <= 1) ctx.fillRect(x, y, pix, pix);
      }
  },

  // ring / arc; frac<1 draws a partial sweep clockwise from the top (for meters)
  ring(ctx, cx, cy, r, color, pix = 2, thick = pix * 2, frac = 1) {
    ctx.fillStyle = color;
    const inner = r - thick;
    const x0 = Math.floor((cx - r) / pix) * pix, x1 = Math.ceil((cx + r) / pix) * pix;
    const y0 = Math.floor((cy - r) / pix) * pix, y1 = Math.ceil((cy + r) / pix) * pix;
    for (let y = y0; y < y1; y += pix)
      for (let x = x0; x < x1; x += pix) {
        const dx = x + pix / 2 - cx, dy = y + pix / 2 - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > r || d < inner) continue;
        if (frac < 1) { let a = Math.atan2(dy, dx) + Math.PI / 2; if (a < 0) a += Math.PI * 2; if (a > frac * Math.PI * 2) continue; }
        ctx.fillRect(x, y, pix, pix);
      }
  },

  line(ctx, x0, y0, x1, y1, color, pix = 2, thick = pix) {
    ctx.fillStyle = color;
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / pix));
    for (let i = 0; i <= steps; i++) {
      const bx = Math.floor((x0 + dx * i / steps) / pix) * pix;
      const by = Math.floor((y0 + dy * i / steps) / pix) * pix;
      ctx.fillRect(bx, by, thick, thick);
    }
  },

  // axis-aligned bracket corners (RTS selection marker)
  brackets(ctx, cx, cy, r, color, len = 4, th = 2) {
    ctx.fillStyle = color;
    const L = cx - r, R = cx + r - th, T = cy - r, B = cy + r - th;
    for (const [hx, vy] of [[L, T], [R, T], [L, B], [R, B]]) {
      const ix = hx === L ? L : R + th - len;
      const iy = vy === T ? T : B + th - len;
      ctx.fillRect(ix, vy, len, th);
      ctx.fillRect(hx === L ? L : R + th - th, iy, th, len);
    }
  },
};
