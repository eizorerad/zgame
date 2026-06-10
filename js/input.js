/* =========================================================================
 * input.js — player controls.
 *
 * SELECT
 *   Left-click a unit ............ select it
 *   Left-drag .................... box-select your units
 *   Shift + click / drag ......... add to the current selection
 *   Click your factory ........... open its build panel
 *   Esc .......................... clear selection
 *
 * ORDER (right-click is context-sensitive on the current selection)
 *   Right-click ground ........... MOVE  (go through — fire only at point-blank
 *                                  enemies, never chase off course)
 *   Right-click enemy ............ ATTACK that target (pursue to the death)
 *   Right-click an enemy/neutral
 *      flag or sector ............ CAPTURE (move onto the flag to take it)
 *   Right-click empty vehicle .... go crew it
 *   A then click ................. ATTACK-MOVE (advance and engage anything seen)
 *   Right-click (factory sel.) ... set the factory rally point
 *   H = hold position    S = stop
 * ========================================================================= */

const Input = {
  drag: null,                 // {x0,y0,x1,y1,additive}
  selectedFactory: null,
  selectedFort: null,
  mouse: { x: 0, y: 0 },
  attackMoveArmed: false,     // 'A' pressed, waiting for the target click
  hover: { kind: "move" },    // what a right-click would do at the cursor

  keys: new Set(),
  edge: { dx: 0, dy: 0 },     // current edge-scroll direction (persists when the cursor leaves)
  popupRects: [],             // clickable unit rows in the factory popup (screen space)
  groups: {},                 // control groups: digit -> array of units
  _lastGroupKey: null,        // for double-tap-to-centre
  _lastGroupTime: 0,
  _lastClick: { t: 0, id: 0 },// for double-click select-all-of-type

  init(canvas) {
    this.canvas = canvas;
    this.mouse = { x: 0, y: 0, in: false };
    canvas.style.cursor = "none";   // we draw our own cursor

    canvas.addEventListener("contextmenu", e => e.preventDefault());

    canvas.addEventListener("mousedown", e => {
      Sound.init();                                   // first gesture unlocks audio
      const p = this._pt(e); this.mouse.x = p.x; this.mouse.y = p.y; this.mouse.in = true;
      if (e.button === 0) {
        if (this._minimapClick(p)) return;            // jump the camera
        if (this._popupClick(p)) return;              // pick a unit in the factory popup
        if (this.attackMoveArmed) { this._issueAttackMove(this.world(p)); this.attackMoveArmed = false; return; }
        this.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: e.shiftKey };
      } else if (e.button === 2) {
        if (this._minimapOrder(p, e)) return;         // right-click the minimap = order there
        this._rightClick(this.world(p), e);
      }
    });

    canvas.addEventListener("mousemove", e => {
      const p = this._pt(e); this.mouse.x = p.x; this.mouse.y = p.y; this.mouse.in = true;
      this._setEdge(p, false);
      if (this.drag) { this.drag.x1 = p.x; this.drag.y1 = p.y; }
      this._updateHover(this.world(p), e);
    });

    // when the cursor leaves the (smaller-than-window) canvas, keep scrolling
    // in the direction it was last pushing — don't freeze the camera
    canvas.addEventListener("mouseleave", e => { this.mouse.in = false; this._setEdge(this._pt(e), true); });
    canvas.addEventListener("mouseenter", () => { /* mousemove will recompute edge */ });

    window.addEventListener("mouseup", e => {
      if (e.button === 0 && this.drag) { this._leftRelease(this.drag); this.drag = null; }
    });

    window.addEventListener("keydown", e => {
      Sound.init();
      const k = e.key.toLowerCase();
      this.keys.add(k);
      // control groups: Ctrl+digit assigns, digit selects, double-tap centres
      if (k >= "1" && k <= "9") {
        if (e.ctrlKey || e.metaKey) { this._assignGroup(k); e.preventDefault(); }
        else this._recallGroup(k);
        return;
      }
      if (e.ctrlKey || e.metaKey) return;             // don't eat browser shortcuts
      if (k === "a") this.attackMoveArmed = !this.attackMoveArmed;
      else if (k === "h") { this._forSelected(u => u.orderHold()); this.attackMoveArmed = false; }
      else if (k === "s") { this._forSelected(u => u.stop()); this.attackMoveArmed = false; }
      else if (k === "u") this._unloadSelected();
      else if (k === "p") { G.paused = !G.paused; }
      else if (k === "m") { Sound.toggleMute(); }
      else if (k === "+" || k === "=") G.speedMult = Math.min(2, (G.speedMult || 1) * 2);
      else if (k === "-" || k === "_") G.speedMult = Math.max(0.5, (G.speedMult || 1) / 2);
      else if (k === "escape") { this._clearSelection(); this.selectedFactory = null; this.selectedFort = null; this.attackMoveArmed = false; UI.refreshFactoryPanel(); }
    });
    window.addEventListener("keyup", e => this.keys.delete(e.key.toLowerCase()));
  },

  /* ---- control groups -------------------------------------------------- */
  _assignGroup(k) {
    const sel = G.units.filter(u => u.selected && u.alive);
    if (sel.length) { this.groups[k] = sel.slice(); Sound.play("select"); }
  },

  _recallGroup(k) {
    const g = (this.groups[k] || []).filter(u => u.alive && u.team === G.player && u.crewed);
    this.groups[k] = g;
    if (!g.length) return;
    this._clearSelection();
    for (const u of g) u.selected = true;
    this.selectedFactory = null; this.selectedFort = null;
    Sound.play("select");
    // double-tap: jump the camera to the group
    const now = performance.now();
    if (this._lastGroupKey === k && now - this._lastGroupTime < 450) {
      let cx = 0, cy = 0;
      for (const u of g) { cx += u.x; cy += u.y; }
      G.centerCam(cx / g.length, cy / g.length);
    }
    this._lastGroupKey = k; this._lastGroupTime = now;
  },

  // unload every selected transport's passengers
  _unloadSelected() {
    for (const u of G.units) {
      if (!u.selected || !u.alive || !u.cargo || !u.cargo.length) continue;
      for (const c of u.cargo) {
        const s = G.freeSpotNear(u.x + Util.rand(-16, 16), u.y + u.radius + 10);
        const inf = new Unit("infantry", c.typeKey, c.team, s.x, s.y);
        inf.hp = c.hp; inf.maxHp = c.maxHp; inf.kills = c.kills; inf.rank = c.rank;
        G.units.push(inf);
      }
      u.cargo.length = 0;
      Sound.playAt("unload", u.x, u.y);
    }
  },

  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width / r.width, sy = this.canvas.height / r.height;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  },

  // screen -> world coordinate (account for the camera)
  world(p) { return { x: p.x + G.cam.x, y: p.y + G.cam.y }; },

  // compute the edge-scroll direction from a cursor position. On `leaving`
  // (cursor exiting the canvas) infer the exit side so scrolling continues.
  _setEdge(p, leaving) {
    const e = 28; let dx = 0, dy = 0;
    if (p.x < e) dx = -1; else if (p.x > CFG.VIEW_W - e) dx = 1;
    if (p.y < e) dy = -1; else if (p.y > CFG.VIEW_H - e) dy = 1;
    if (leaving && dx === 0 && dy === 0) {
      if (p.x <= 0) dx = -1; else if (p.x >= CFG.VIEW_W) dx = 1;
      if (p.y <= 0) dy = -1; else if (p.y >= CFG.VIEW_H) dy = 1;
    }
    this.edge = { dx, dy };
  },

  // clicking the minimap recentres the camera there
  _minimapClick(p) {
    const mm = G.mm;
    if (!mm || p.x < mm.ox || p.x > mm.ox + mm.w || p.y < mm.oy || p.y > mm.oy + mm.h) return false;
    G.centerCam((p.x - mm.ox) / mm.w * G.worldW(), (p.y - mm.oy) / mm.h * G.worldH());
    return true;
  },

  // right-clicking the minimap orders the selection to that world point
  _minimapOrder(p, e) {
    const mm = G.mm;
    if (!mm || p.x < mm.ox || p.x > mm.ox + mm.w || p.y < mm.oy || p.y > mm.oy + mm.h) return false;
    const sel = G.units.filter(u => u.selected && u.alive);
    if (!sel.length) return true;
    const wx = (p.x - mm.ox) / mm.w * G.worldW();
    const wy = (p.y - mm.oy) / mm.h * G.worldH();
    this._formMove(sel, wx, wy, this.attackMoveArmed, e.shiftKey);
    this.attackMoveArmed = false;
    G.fx.push(new CommandMarker(wx, wy, "move"));
    Sound.play("order");
    return true;
  },

  // clicking an entry in any building popup runs its action
  // (factory: set production; HQ: train / instant build / upgrade)
  _popupClick(p) {
    if (!this.selectedFactory && !this.selectedFort) return false;
    for (const r of this.popupRects) {
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
        if (r.act) r.act();
        UI.refreshFactoryPanel();
        return true;
      }
    }
    return false;
  },

  hasSelection() { return G.units.some(u => u.selected && u.alive); },

  /* ---- left button: selection --------------------------------------- */
  _leftRelease(d) {
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w < 5 && h < 5) { this._click(d); return; }

    if (!d.additive) this._clearSelection();
    const x0 = Math.min(d.x0, d.x1) + G.cam.x, x1 = Math.max(d.x0, d.x1) + G.cam.x;
    const y0 = Math.min(d.y0, d.y1) + G.cam.y, y1 = Math.max(d.y0, d.y1) + G.cam.y;
    for (const u of G.units) {
      if (!u.alive || u.team !== G.player || !u.crewed) continue;
      if (u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1) u.selected = true;
    }
    this.selectedFactory = null; this.selectedFort = null;
    UI.refreshFactoryPanel();
  },

  _click(d) {
    const p = this.world({ x: d.x1, y: d.y1 });
    // your own HQ? open the command panel
    const fort = G.fortAt(p.x, p.y);
    if (fort && fort.team === G.player) {
      this._clearSelection();
      this.selectedFort = fort; this.selectedFactory = null; UI.refreshFactoryPanel(); return;
    }
    // your own factory? open build panel
    const f = G.factoryAt(p.x, p.y);
    if (f && f.team === G.player) {
      this._clearSelection();
      this.selectedFactory = f; this.selectedFort = null; UI.refreshFactoryPanel(); return;
    }
    const u = G.unitAt(p.x, p.y);
    if (!d.additive) this._clearSelection();
    if (u && u.team === G.player && u.crewed) {
      // double-click: select every unit of this type currently on screen
      const now = performance.now();
      if (this._lastClick.id === u.id && now - this._lastClick.t < 400) {
        for (const o of G.units) {
          if (o.alive && o.crewed && o.team === G.player && o.typeKey === u.typeKey &&
              G._inView(o.x, o.y, 0)) o.selected = true;
        }
      } else {
        u.selected = !d.additive ? true : !u.selected;
      }
      this._lastClick = { t: now, id: u.id };
      Sound.play("select");
    }
    this.selectedFactory = null; this.selectedFort = null;
    UI.refreshFactoryPanel();
  },

  /* ---- right button: context order ----------------------------------- */
  _rightClick(p, e) {
    // factory / HQ selected -> set rally
    const depot = this.selectedFort || this.selectedFactory;
    if (depot && depot.team === G.player) {
      depot.rally = { x: p.x, y: p.y };
      G.fx.push(new CommandMarker(p.x, p.y, "rally"));
      Sound.play("order");
      return;
    }
    const sel = G.units.filter(u => u.selected && u.alive);
    if (!sel.length) return;
    const queued = e.shiftKey;          // shift: append instead of replacing

    // friendly transport with room? selected infantry climbs aboard
    const apc = this._transportAt(p);
    if (apc && sel.some(u => u.kind === "infantry" && u !== apc)) {
      for (const u of sel) {
        if (u === apc) continue;
        if (u.kind === "infantry") {
          if (queued && u.order !== "idle") u.queueOrder({ kind: "board", entity: apc });
          else u.orderBoard(apc);
        } else if (!queued) u.orderMove(p.x, p.y);
      }
      G.fx.push(new CommandMarker(apc.x, apc.y, "rally"));
      Sound.play("order");
      return;
    }

    const enemy = this._enemyAt(p);
    if (enemy) {
      for (const u of sel) {
        if (queued && u.order !== "idle") u.queueOrder({ kind: "attack", entity: enemy });
        else u.orderAttack(enemy);
      }
      G.fx.push(new CommandMarker(enemy.x, enemy.y, "attack"));
      Sound.play("order");
      return;
    }
    // capture: right-click on an enemy/neutral sector sends units onto its flag
    const sec = Sectors.sectorAt(p.x, p.y);
    if (sec && sec.flag && sec.owner !== G.player) {
      this._formMove(sel, sec.flag.x, sec.flag.y, false, queued);
      G.fx.push(new CommandMarker(sec.flag.x, sec.flag.y, "capture"));
      Sound.play("order");
      return;
    }
    // plain move
    this._formMove(sel, p.x, p.y, false, queued);
    G.fx.push(new CommandMarker(p.x, p.y, "move"));
    Sound.play("order");
  },

  _issueAttackMove(p) {
    const sel = G.units.filter(u => u.selected && u.alive);
    if (!sel.length) return;
    this._formMove(sel, p.x, p.y, true, this.keys.has("shift"));
    G.fx.push(new CommandMarker(p.x, p.y, "amove"));
    Sound.play("order");
  },

  // spread units into a small grid so they don't pile on one tile; group
  // moves are capped to the slowest member's speed so they arrive together
  _formMove(sel, px, py, attackMove, queued) {
    const n = sel.length, cols = Math.ceil(Math.sqrt(n));
    let cap = null;
    if (n > 1) {
      cap = Infinity;
      for (const u of sel) if (u.speed > 0) cap = Math.min(cap, u.speed);  // immobile guns don't freeze the group
      if (cap === Infinity) cap = null;
    }
    let i = 0;
    for (const u of sel) {
      const ox = (i % cols - cols / 2) * 14, oy = (Math.floor(i / cols) - cols / 2) * 14;
      const kind = attackMove ? "amove" : "move";
      if (queued && u.order !== "idle") u.queueOrder({ kind, x: px + ox, y: py + oy, speedCap: cap });
      else if (attackMove) u.orderAttackMove(px + ox, py + oy, cap);
      else u.orderMove(px + ox, py + oy, cap);
      i++;
    }
  },

  // a crewed friendly APC with spare seats under the cursor
  _transportAt(p) {
    const u = G.unitAt(p.x, p.y);
    if (u && u.alive && u.team === G.player && u.cargo && u.driver &&
        u.cargo.length < u.stats.transport) return u;
    return null;
  },

  _enemyAt(p) {
    const u = G.unitAt(p.x, p.y);
    if (u && u.team !== G.player && u.team !== TEAM.NEUTRAL && u.crewed) return u;
    const ft = G.fortAt(p.x, p.y);
    if (ft && ft.alive && ft.team !== G.player) return ft;
    const fa = G.factoryAt(p.x, p.y);
    if (fa && fa.team !== G.player && fa.team !== TEAM.NEUTRAL) return fa;
    return null;
  },

  /* ---- hover: decide what the cursor should advertise ----------------- */
  _updateHover(p, e) {
    if (this.selectedFactory || this.selectedFort) { this.hover = { kind: "rally" }; return; }
    if (!this.hasSelection()) {
      const u = G.unitAt(p.x, p.y);
      this.hover = { kind: (u && u.team === G.player && u.crewed) ? "select" : "none" };
      return;
    }
    if (this.attackMoveArmed) { this.hover = { kind: "amove" }; return; }
    if (this._enemyAt(p)) { this.hover = { kind: "attack" }; return; }
    const apc = this._transportAt(p);
    if (apc && G.units.some(u => u.selected && u.alive && u.kind === "infantry" && u !== apc)) {
      this.hover = { kind: "board" }; return;
    }
    const sec = Sectors.sectorAt(p.x, p.y);
    if (sec && sec.flag && sec.owner !== G.player) { this.hover = { kind: "capture" }; return; }
    this.hover = { kind: "move" };
  },

  _forSelected(fn) { for (const u of G.units) if (u.selected && u.alive) fn(u); },
  _clearSelection() { for (const u of G.units) u.selected = false; },
};

/* ---- HUD / factory build panel ---------------------------------------- */
const UI = {
  el: {},
  init() {
    this.el = {
      blueSectors: document.getElementById("blue-sectors"),
      redSectors: document.getElementById("red-sectors"),
      blueUnits: document.getElementById("blue-units"),
      redUnits: document.getElementById("red-units"),
      blueSpeed: document.getElementById("blue-speed"),
      redSpeed: document.getElementById("red-speed"),
      blueFort: document.getElementById("blue-fort"),
      redFort: document.getElementById("red-fort"),
      blueMana: document.getElementById("blue-mana"),
      clock: document.getElementById("clock"),
      overlay: document.getElementById("overlay"),
      overlayTitle: document.getElementById("overlay-title"),
      overlayText: document.getElementById("overlay-text"),
      overlayBtn: document.getElementById("overlay-btn"),
    };
  },

  refreshHud() {
    const e = this.el;
    e.blueSectors.textContent = Sectors.countOwned(TEAM.BLUE);
    e.redSectors.textContent = Sectors.countOwned(TEAM.RED);
    e.blueUnits.textContent = `${G.unitCount(TEAM.BLUE)}/${CFG.MAX_POP}`;
    e.redUnits.textContent = G.unitCount(TEAM.RED);
    e.blueSpeed.textContent = Sectors.speedMultiplier(TEAM.BLUE).toFixed(1);
    e.redSpeed.textContent = Sectors.speedMultiplier(TEAM.RED).toFixed(1);
    const bf = G.forts.find(f => f.team === TEAM.BLUE);
    const rf = G.forts.find(f => f.team === TEAM.RED);
    e.blueFort.textContent = bf ? Math.max(0, Math.ceil(bf.hp / bf.maxHp * 100)) : 0;
    e.redFort.textContent = rf ? Math.max(0, Math.ceil(rf.hp / rf.maxHp * 100)) : 0;
    e.blueMana.textContent = Math.floor(G.mana[TEAM.BLUE]);
    e.clock.textContent = Util.fmtTime(G.time);
  },

  // Building UI is now the in-canvas popups (drawn over the factory / HQ),
  // so the old bottom DOM panel is gone — nothing here resizes the page.
  refreshFactoryPanel() {},

  showOverlay(title, text, btnLabel, cb) {
    this.el.overlayTitle.textContent = title;
    this.el.overlayText.textContent = text;
    this.el.overlayBtn.textContent = btnLabel;
    this.el.overlay.classList.remove("hidden");
    this.el.overlayBtn.onclick = () => { this.el.overlay.classList.add("hidden"); cb(); };
  },
};
