/* =========================================================================
 * pathfinding.js — dynamic A* on the tile grid.
 *
 * The grid is *dynamic*: walls can be destroyed mid-game, so we never cache
 * the passability map. When a unit cannot reach its goal because a
 * DESTRUCTIBLE wall is in the way, we hand back the first such wall so the
 * unit AI can attack it to clear its own path (per the Z behaviour spec).
 * ========================================================================= */

const Path = {
  /* Find a path of tile coords from (sx,sy) to (gx,gy).
   * passable(tx,ty)         -> true if a unit may stand there normally
   * passableIgnoreWall(tx,ty) -> true if only DESTRUCTIBLE walls block it
   *
   * Returns: { tiles:[{x,y}...], blockedByWall:{x,y}|null, reached:bool }
   */
  find(sx, sy, gx, gy, passable, passableIgnoreWall) {
    // First attempt: respect all obstacles.
    let result = Path._astar(sx, sy, gx, gy, passable);
    if (result.reached) return { tiles: result.tiles, blockedByWall: null, reached: true };

    // Second attempt: pretend destructible walls are open. If THAT path
    // exists, the obstruction is a wall we can shoot through.
    let dig = Path._astar(sx, sy, gx, gy, passableIgnoreWall);
    if (dig.reached) {
      // walk the dig path and return the first tile that is a wall.
      for (const t of dig.tiles) {
        if (!passable(t.x, t.y) && passableIgnoreWall(t.x, t.y)) {
          return { tiles: dig.tiles, blockedByWall: { x: t.x, y: t.y }, reached: false };
        }
      }
    }

    // Truly stuck (or goal unreachable): return best-effort partial path
    // toward the closest explored tile.
    return { tiles: result.tiles, blockedByWall: null, reached: false };
  },

  _astar(sx, sy, gx, gy, passable) {
    const COLS = CFG.COLS, ROWS = CFG.ROWS;
    if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) {
      return { tiles: [], reached: false };
    }
    const key = (x, y) => y * COLS + x;
    const open = new MinHeap();
    const gScore = new Map();
    const came = new Map();
    const closed = new Set();

    const h = (x, y) => Math.abs(x - gx) + Math.abs(y - gy);
    const startK = key(sx, sy);
    gScore.set(startK, 0);
    open.push({ x: sx, y: sy, f: h(sx, sy) });

    let best = { x: sx, y: sy }, bestH = h(sx, sy);
    let found = false;
    let iter = 0;
    const MAX = COLS * ROWS * 4;

    const N = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

    while (!open.isEmpty() && iter++ < MAX) {
      const cur = open.pop();
      const ck = key(cur.x, cur.y);
      if (closed.has(ck)) continue;
      closed.add(ck);

      const ch = h(cur.x, cur.y);
      if (ch < bestH) { bestH = ch; best = { x: cur.x, y: cur.y }; }

      if (cur.x === gx && cur.y === gy) { found = true; break; }

      for (const [dx, dy] of N) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
        if (!passable(nx, ny)) continue;
        // prevent corner-cutting through diagonal walls
        if (dx !== 0 && dy !== 0) {
          if (!passable(cur.x + dx, cur.y) || !passable(cur.x, cur.y + dy)) continue;
        }
        const nk = key(nx, ny);
        if (closed.has(nk)) continue;
        const step = (dx !== 0 && dy !== 0) ? 1.414 : 1;
        const tentative = gScore.get(ck) + step;
        if (!gScore.has(nk) || tentative < gScore.get(nk)) {
          gScore.set(nk, tentative);
          came.set(nk, cur);
          open.push({ x: nx, y: ny, f: tentative + h(nx, ny) });
        }
      }
    }

    // reconstruct from goal (if found) or closest tile.
    const endX = found ? gx : best.x, endY = found ? gy : best.y;
    const tiles = [];
    let node = { x: endX, y: endY };
    while (node) {
      tiles.unshift({ x: node.x, y: node.y });
      node = came.get(key(node.x, node.y));
    }
    if (tiles.length) tiles.shift(); // drop the starting tile
    return { tiles, reached: found };
  },
};

/* tiny binary min-heap keyed on .f */
class MinHeap {
  constructor() { this.a = []; }
  isEmpty() { return this.a.length === 0; }
  push(n) {
    const a = this.a; a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      const n = a.length;
      while (true) {
        let l = 2 * i + 1, r = 2 * i + 2, s = i;
        if (l < n && a[l].f < a[s].f) s = l;
        if (r < n && a[r].f < a[s].f) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]]; i = s;
      }
    }
    return top;
  }
}
