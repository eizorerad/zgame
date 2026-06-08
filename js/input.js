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
  mouse: { x: 0, y: 0 },
  attackMoveArmed: false,     // 'A' pressed, waiting for the target click
  hover: { kind: "move" },    // what a right-click would do at the cursor

  init(canvas) {
    this.canvas = canvas;
    canvas.style.cursor = "none";   // we draw our own cursor

    canvas.addEventListener("contextmenu", e => e.preventDefault());

    canvas.addEventListener("mousedown", e => {
      const p = this._pt(e); this.mouse = p;
      if (e.button === 0) {
        if (this.attackMoveArmed) { this._issueAttackMove(p); this.attackMoveArmed = false; return; }
        this.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: e.shiftKey };
      } else if (e.button === 2) {
        this._rightClick(p, e);
      }
    });

    canvas.addEventListener("mousemove", e => {
      const p = this._pt(e); this.mouse = p;
      if (this.drag) { this.drag.x1 = p.x; this.drag.y1 = p.y; }
      this._updateHover(p, e);
    });

    window.addEventListener("mouseup", e => {
      if (e.button === 0 && this.drag) { this._leftRelease(this.drag); this.drag = null; }
    });

    window.addEventListener("keydown", e => {
      const k = e.key.toLowerCase();
      if (k === "a") this.attackMoveArmed = !this.attackMoveArmed;
      else if (k === "h") { this._forSelected(u => u.orderHold()); this.attackMoveArmed = false; }
      else if (k === "s") { this._forSelected(u => u.stop()); this.attackMoveArmed = false; }
      else if (k === "escape") { this._clearSelection(); this.selectedFactory = null; this.attackMoveArmed = false; UI.refreshFactoryPanel(); }
    });
  },

  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width / r.width, sy = this.canvas.height / r.height;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  },

  hasSelection() { return G.units.some(u => u.selected && u.alive); },

  /* ---- left button: selection --------------------------------------- */
  _leftRelease(d) {
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w < 5 && h < 5) { this._click(d); return; }

    if (!d.additive) this._clearSelection();
    const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
    const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
    for (const u of G.units) {
      if (!u.alive || u.team !== G.player || !u.crewed) continue;
      if (u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1) u.selected = true;
    }
    this.selectedFactory = null;
    UI.refreshFactoryPanel();
  },

  _click(d) {
    const p = { x: d.x1, y: d.y1 };
    // your own factory? open build panel
    const f = G.factoryAt(p.x, p.y);
    if (f && f.team === G.player) {
      this._clearSelection();
      this.selectedFactory = f; UI.refreshFactoryPanel(); return;
    }
    const u = G.unitAt(p.x, p.y);
    if (!d.additive) this._clearSelection();
    if (u && u.team === G.player && u.crewed) u.selected = !d.additive ? true : !u.selected;
    this.selectedFactory = null;
    UI.refreshFactoryPanel();
  },

  /* ---- right button: context order ----------------------------------- */
  _rightClick(p, e) {
    // factory selected -> set rally
    if (this.selectedFactory && this.selectedFactory.team === G.player) {
      this.selectedFactory.rally = { x: p.x, y: p.y };
      G.fx.push(new CommandMarker(p.x, p.y, "rally"));
      return;
    }
    const sel = G.units.filter(u => u.selected && u.alive);
    if (!sel.length) return;

    const enemy = this._enemyAt(p);
    if (enemy) {
      for (const u of sel) u.orderAttack(enemy);
      G.fx.push(new CommandMarker(enemy.x, enemy.y, "attack"));
      return;
    }
    // capture: right-click on an enemy/neutral sector sends units onto its flag
    const sec = Sectors.sectorAt(p.x, p.y);
    if (sec && sec.flag && sec.owner !== G.player) {
      this._formMove(sel, sec.flag.x, sec.flag.y, false);
      G.fx.push(new CommandMarker(sec.flag.x, sec.flag.y, "capture"));
      return;
    }
    // plain move
    this._formMove(sel, p.x, p.y, false);
    G.fx.push(new CommandMarker(p.x, p.y, "move"));
  },

  _issueAttackMove(p) {
    const sel = G.units.filter(u => u.selected && u.alive);
    if (!sel.length) return;
    this._formMove(sel, p.x, p.y, true);
    G.fx.push(new CommandMarker(p.x, p.y, "amove"));
  },

  // spread units into a small grid so they don't pile on one tile
  _formMove(sel, px, py, attackMove) {
    const n = sel.length, cols = Math.ceil(Math.sqrt(n));
    let i = 0;
    for (const u of sel) {
      const ox = (i % cols - cols / 2) * 14, oy = (Math.floor(i / cols) - cols / 2) * 14;
      if (attackMove) u.orderAttackMove(px + ox, py + oy);
      else u.orderMove(px + ox, py + oy);
      i++;
    }
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
    if (this.selectedFactory) { this.hover = { kind: "rally" }; return; }
    if (!this.hasSelection()) {
      const u = G.unitAt(p.x, p.y);
      this.hover = { kind: (u && u.team === G.player && u.crewed) ? "select" : "none" };
      return;
    }
    if (this.attackMoveArmed) { this.hover = { kind: "amove" }; return; }
    if (this._enemyAt(p)) { this.hover = { kind: "attack" }; return; }
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
      clock: document.getElementById("clock"),
      buildBtns: document.getElementById("build-buttons"),
      panel: document.getElementById("factory-panel"),
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
    e.blueUnits.textContent = G.unitCount(TEAM.BLUE);
    e.redUnits.textContent = G.unitCount(TEAM.RED);
    e.blueSpeed.textContent = Sectors.speedMultiplier(TEAM.BLUE).toFixed(1);
    e.redSpeed.textContent = Sectors.speedMultiplier(TEAM.RED).toFixed(1);
    const bf = G.forts.find(f => f.team === TEAM.BLUE);
    const rf = G.forts.find(f => f.team === TEAM.RED);
    e.blueFort.textContent = bf ? Math.max(0, Math.ceil(bf.hp / bf.maxHp * 100)) : 0;
    e.redFort.textContent = rf ? Math.max(0, Math.ceil(rf.hp / rf.maxHp * 100)) : 0;
    e.clock.textContent = Util.fmtTime(G.time);
  },

  refreshFactoryPanel() {
    const wrap = this.el.buildBtns;
    wrap.innerHTML = "";
    const f = Input.selectedFactory;
    if (!f) { this.el.panel.classList.add("empty"); return; }
    this.el.panel.classList.remove("empty");
    for (const key of f.spec.keys) {
      const def = f.spec.table[key];
      const btn = document.createElement("button");
      btn.className = "build-btn" + (f.queueKey === key ? " active" : "");
      btn.textContent = `${def.name} (${def.baseTime}s)`;
      btn.onclick = () => { f.setQueue(key); this.refreshFactoryPanel(); };
      wrap.appendChild(btn);
    }
  },

  showOverlay(title, text, btnLabel, cb) {
    this.el.overlayTitle.textContent = title;
    this.el.overlayText.textContent = text;
    this.el.overlayBtn.textContent = btnLabel;
    this.el.overlay.classList.remove("hidden");
    this.el.overlayBtn.onclick = () => { this.el.overlay.classList.add("hidden"); cb(); };
  },
};
