/* =========================================================================
 * input.js — player controls.
 *   - left-drag : box select your own units
 *   - left-click: select a unit, or a factory you own (opens build panel)
 *   - right-click: move / attack with the current selection
 *   - H : hold position   S : stop   A: (with target) force-attack-move
 * ========================================================================= */

const Input = {
  drag: null,           // {x0,y0,x1,y1}
  selectedFactory: null,
  mouse: { x: 0, y: 0 },

  init(canvas) {
    this.canvas = canvas;

    canvas.addEventListener("contextmenu", e => e.preventDefault());

    canvas.addEventListener("mousedown", e => {
      const p = this._pt(e);
      this.mouse = p;
      if (e.button === 0) {
        this.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      } else if (e.button === 2) {
        this._rightClick(p);
      }
    });

    canvas.addEventListener("mousemove", e => {
      const p = this._pt(e);
      this.mouse = p;
      if (this.drag) { this.drag.x1 = p.x; this.drag.y1 = p.y; }
    });

    window.addEventListener("mouseup", e => {
      if (e.button === 0 && this.drag) {
        this._leftRelease(this.drag);
        this.drag = null;
      }
    });

    window.addEventListener("keydown", e => {
      const k = e.key.toLowerCase();
      if (k === "h") this._forSelected(u => u.orderHold());
      else if (k === "s") this._forSelected(u => u.stop());
      else if (k === "escape") this._clearSelection();
    });
  },

  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width / r.width;
    const sy = this.canvas.height / r.height;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  },

  _leftRelease(d) {
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w < 5 && h < 5) { this._click({ x: d.x1, y: d.y1 }); return; }

    // box select own crewed units
    this._clearSelection();
    const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
    const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
    for (const u of G.units) {
      if (!u.alive || u.team !== G.player) continue;
      if (u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1) u.selected = true;
    }
    this.selectedFactory = null;
    UI.refreshFactoryPanel();
  },

  _click(p) {
    // factory of mine?
    const f = G.factoryAt(p.x, p.y);
    if (f && f.team === G.player) {
      this._clearSelection();
      this.selectedFactory = f;
      UI.refreshFactoryPanel();
      return;
    }
    // single unit of mine?
    const u = G.unitAt(p.x, p.y);
    this._clearSelection();
    if (u && u.team === G.player && u.crewed) {
      u.selected = true;
    }
    this.selectedFactory = null;
    UI.refreshFactoryPanel();
  },

  _rightClick(p) {
    // if a factory is selected, set its rally point
    if (this.selectedFactory && this.selectedFactory.team === G.player) {
      this.selectedFactory.rally = { x: p.x, y: p.y };
      return;
    }
    const sel = G.units.filter(u => u.selected && u.alive);
    if (!sel.length) return;

    const enemy = G.unitAt(p.x, p.y) || G.fortAt(p.x, p.y) || G.factoryAt(p.x, p.y);
    if (enemy && enemy.team && enemy.team !== G.player && enemy.team !== TEAM.NEUTRAL) {
      for (const u of sel) u.orderAttack(enemy);
      return;
    }
    // empty machine -> go crew it (move order; crewing is automatic on touch)
    // otherwise plain move, in a little formation so they don't stack
    let i = 0;
    const n = sel.length;
    const cols = Math.ceil(Math.sqrt(n));
    for (const u of sel) {
      const ox = (i % cols - cols / 2) * 14;
      const oy = (Math.floor(i / cols) - cols / 2) * 14;
      u.orderMove(p.x + ox, p.y + oy);
      i++;
    }
  },

  _forSelected(fn) {
    for (const u of G.units) if (u.selected && u.alive) fn(u);
  },

  _clearSelection() {
    for (const u of G.units) u.selected = false;
  },
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
