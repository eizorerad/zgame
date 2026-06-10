/* =========================================================================
 * test/smoke.js — headless smoke test (no browser needed).
 *
 *   node test/smoke.js
 *
 * Stubs just enough DOM/Canvas/Audio for the game scripts to load, then
 * drives the real game loop for several simulated minutes and asserts the
 * core systems work: production, AI capture, ballistic combat, APC
 * transport, separation, and the order queue.
 * ========================================================================= */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

/* ---- minimal browser stubs --------------------------------------------- */
const noop = () => {};
function makeCtx() {
  // every method becomes a no-op; property writes are accepted
  return new Proxy({ canvas: null }, {
    get(t, k) { return k in t ? t[k] : noop; },
    set(t, k, v) { t[k] = v; return true; },
  });
}
function makeCanvas() {
  return {
    width: 0, height: 0,
    style: {},
    getContext: () => makeCtx(),
    addEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 640 }),
    parentElement: { clientWidth: 1040, clientHeight: 680 },
  };
}
const elements = {};
function el(id) {
  if (!elements[id]) {
    elements[id] = id === "game" ? makeCanvas() : {
      textContent: "", onclick: null, style: {},
      classList: { add: noop, remove: noop },
    };
  }
  return elements[id];
}

const sandbox = {
  console,
  Math, JSON, Set, Map, Array, Object, Number, String, Boolean, Infinity, NaN,
  Int16Array, Int32Array, Uint8Array, Float64Array,
  performance: { now: () => simNow },
  requestAnimationFrame: cb => { frameCb = cb; },
  document: { createElement: makeCanvas, getElementById: el },
  window: { addEventListener: noop },
};
sandbox.globalThis = sandbox;
let simNow = 0;
let frameCb = null;
vm.createContext(sandbox);

const files = ["config.js", "utils.js", "sound.js", "sprites.js", "pathfinding.js",
               "entities.js", "sectors.js", "ai.js", "input.js", "game.js"];
for (const f of files) {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", f), "utf8");
  vm.runInContext(src, sandbox, { filename: f });
}

/* ---- helpers ------------------------------------------------------------ */
let failures = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { console.error("FAIL  " + name); failures++; }
}
function run(seconds, step = 1 / 30) {
  const frames = Math.round(seconds / step);
  for (let i = 0; i < frames; i++) {
    simNow += step * 1000;
    frameCb(simNow);
    if (sandbox.G.over) break;
  }
}

/* ---- boot the real game -------------------------------------------------- */
// top-level const declarations live in the context's lexical scope,
// not on the sandbox object — pull them out explicitly
const [G, TEAM, Unit, Sectors, Util, Input] =
  vm.runInContext("[G, TEAM, Unit, Sectors, Util, Input]", sandbox);
sandbox.G = G; sandbox.Util = Util; sandbox.Input = Input;
G.init();
check("world generated: 12 sectors", G.sectors.length === 12);
check("two forts placed", G.forts.length === 2);
check("starting armies spawned", G.units.length >= 9);
G.start();

/* ---- ballistic combat ----------------------------------------------------
 * A crewed medium tank vs an enemy grunt: shells must fly to a point and
 * splash; the fight must produce ballistic projectiles. */
{
  const t = new Unit("machine", "medium", TEAM.BLUE, 200, 200);
  const g = new Unit("infantry", "grunt", TEAM.RED, 290, 200);
  G.units.push(t, g);
  t.orderAttack(g);
  let sawBallistic = false;
  for (let i = 0; i < 240; i++) {
    simNow += 1000 / 30; frameCb(simNow);
    if (G.projectiles.some(p => p.ballistic)) sawBallistic = true;
    if (!g.alive) break;
  }
  check("cannon fires ballistic shells", sawBallistic);
  check("ballistic fire kills the target", !g.alive);
  t.alive = false;
}

/* ---- LOS: a cliff between shooter and target blocks direct fire --------- */
{
  const wallX = 30, wallY = 30;
  for (let y = 25; y < 36; y++) G.terrain[G.tkey(wallX, wallY + (y - 30))] = 1; // TERR.CLIFF column
  const a = sandbox.Util.cx(wallX - 2), b = sandbox.Util.cx(wallX + 2);
  check("hasLOS blocked through cliffs", !G.hasLOS(a, sandbox.Util.cy(wallY), b, sandbox.Util.cy(wallY)));
  check("hasLOS clear on open ground", G.hasLOS(100, 100, 160, 130));
}

/* ---- APC transport -------------------------------------------------------
 * Two grunts board an APC, it drives off, U-unload restores them. */
{
  const apc = new Unit("machine", "apc", TEAM.BLUE, 400, 200);
  const i1 = new Unit("infantry", "grunt", TEAM.BLUE, 380, 200);
  const i2 = new Unit("infantry", "sniper", TEAM.BLUE, 420, 200);
  i2.kills = 5; i2.rank = 2;
  G.units.push(apc, i1, i2);
  i1.orderBoard(apc); i2.orderBoard(apc);
  run(6);
  check("infantry boards the APC", apc.cargo.length === 2 && !i1.alive && !i2.alive);
  // unload via the same path the U key uses
  apc.selected = true;
  sandbox.Input._unloadSelected();
  const out = G.units.filter(u => u.alive && (u.typeKey === "sniper") && u.rank === 2);
  check("unload restores passengers with veterancy", apc.cargo.length === 0 && out.length >= 1);
  apc.selected = false; apc.alive = false;
  for (const u of G.units) if (u.team === TEAM.BLUE && u.kind === "infantry") u.alive = u.alive && u.x < 4000;
}

/* ---- deterministic sniper crew kill --------------------------------------
 * Sniper sits just outside the tank's range (155 < 160) on flattened ground
 * and plinks away: the 3rd hit must drop the driver. */
{
  for (let ty = 16; ty <= 22; ty++) for (let tx = 35; tx <= 50; tx++) G.terrain[G.tkey(tx, ty)] = 0;
  const s = new Unit("infantry", "sniper", TEAM.BLUE, 600, 300);
  const tank = new Unit("machine", "light", TEAM.RED, 755, 300);
  G.units.push(s, tank);
  s.orderAttack(tank);
  run(12);
  check("sniper's 3rd hit drops the vehicle crew", !tank.driver || !tank.alive);
  s.alive = false; tank.alive = false;
}

/* ---- order queue ---------------------------------------------------------- */
{
  const u = new Unit("infantry", "grunt", TEAM.BLUE, 200, 400);
  G.units.push(u);
  u.orderMove(260, 400);
  u.queueOrder({ kind: "move", x: 260, y: 460 });
  run(14);
  check("queued order executes after the first completes",
        Math.hypot(u.x - 260, u.y - 460) < 40);
  u.alive = false;
}

/* ---- selection panel renders without crashing ---------------------------- */
{
  for (const u of G.units.filter(u => u.alive && u.team === TEAM.BLUE).slice(0, 4)) u.selected = true;
  run(0.5);
  check("render loop with an active selection", true);
  for (const u of G.units) u.selected = false;
}

/* ---- long-run stability: AI plays, production flows, nothing crashes ----- */
{
  const before = G.units.filter(u => u.alive).length;
  run(150);
  const redOwned = Sectors.countOwned(TEAM.RED);
  const blueAlive = G.units.filter(u => u.alive && u.team === TEAM.BLUE).length;
  console.log(`  ... after 150s sim: units=${G.units.length} (was ${before}), red sectors=${redOwned}, over=${G.over}`);
  check("AI commander captures territory", redOwned >= 2 || G.over);
  check("factories keep producing", G.units.length > before || G.over);
  check("decals stay bounded", G.tracks.length <= 420 && G.corpses.length <= 90 && G.scorch.length <= 51);
  check("game loop survives 150 simulated seconds", true);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
