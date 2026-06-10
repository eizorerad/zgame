/* =========================================================================
 * sound.js — procedural WebAudio sound effects (no assets, like the art).
 *
 * Every effect is synthesized from oscillators and filtered noise bursts.
 * The context is created lazily on the first user gesture (browser autoplay
 * policy). Each named effect is throttled so 30 rifles firing at once don't
 * become white noise. M toggles mute.
 * ========================================================================= */

const Sound = {
  ctx: null,
  master: null,
  muted: false,
  volume: 0.5,
  _lastPlayed: {},          // name -> ctx.currentTime of last play (throttle)

  // minimum seconds between two plays of the same effect
  THROTTLE: {
    shoot_bullet: 0.06, shoot_flame: 0.09, shoot_snipe: 0.10,
    shoot_cannon: 0.08, shoot_rocket: 0.10,
    explosion: 0.05, crush: 0.15, crewkill: 0.20, crew: 0.15,
    select: 0.05, order: 0.05, capture: 0.50, lost: 0.50,
    rankup: 0.20, unload: 0.15, error: 0.20,
  },

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    // pre-bake one second of white noise; every noise burst reuses it
    const n = this.ctx.sampleRate;
    this._noiseBuf = this.ctx.createBuffer(1, n, n);
    const d = this._noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  },

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.muted;
  },

  /* ---- building blocks -------------------------------------------------- */
  // filtered noise burst: the basis of gunfire and explosions
  _noise(dur, vol, filterType, freq, freqEnd, q) {
    const c = this.ctx, t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = filterType; f.Q.value = q || 0.8;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  },

  // simple tone with pitch + volume envelopes: blips, alarms, fanfares
  _tone(type, freq, freqEnd, dur, vol, delay = 0) {
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },

  /* ---- public API -------------------------------------------------------- */
  play(name, intensity = 1) {
    if (!this.ctx || this.muted) return;
    if (this.ctx.state === "suspended") this.ctx.resume();
    const now = this.ctx.currentTime;
    const min = this.THROTTLE[name] ?? 0.05;
    if (now - (this._lastPlayed[name] || -1) < min) return;
    this._lastPlayed[name] = now;

    switch (name) {
      // weapons — each damage type has its own voice
      case "shoot_bullet":
        this._noise(0.07, 0.10 * intensity, "bandpass", 2400, 900, 1.2);
        break;
      case "shoot_snipe":
        this._noise(0.16, 0.16 * intensity, "highpass", 3200, 1200, 1);
        this._tone("square", 220, 60, 0.10, 0.05);
        break;
      case "shoot_flame":
        this._noise(0.25, 0.08 * intensity, "lowpass", 900, 350, 0.6);
        break;
      case "shoot_cannon":
        this._noise(0.18, 0.18 * intensity, "lowpass", 700, 120, 0.8);
        this._tone("triangle", 110, 40, 0.14, 0.10);
        break;
      case "shoot_rocket":
        this._noise(0.45, 0.10 * intensity, "bandpass", 500, 2400, 0.7); // rising whoosh
        break;

      case "explosion": {
        const v = Util.clamp(0.12 + intensity * 0.02, 0.1, 0.4);
        this._noise(0.5 + intensity * 0.012, v, "lowpass", 900, 60, 0.7);
        this._tone("sine", 90, 28, 0.35, v * 0.9);                       // sub thump
        break;
      }
      case "crush":
        this._noise(0.12, 0.12, "lowpass", 500, 120, 1);
        break;
      case "crewkill":                                                    // sniper crack + bell
        this._noise(0.10, 0.14, "highpass", 3000, 1500, 1);
        this._tone("square", 1180, 1180, 0.10, 0.05, 0.05);
        break;
      case "crew":                                                        // mechanical clunk
        this._tone("square", 140, 80, 0.07, 0.08);
        this._tone("square", 220, 150, 0.06, 0.06, 0.06);
        break;
      case "unload":
        this._tone("square", 220, 150, 0.06, 0.06);
        this._tone("square", 140, 80, 0.07, 0.08, 0.06);
        break;

      // UI feedback
      case "select": this._tone("square", 880, 880, 0.035, 0.030); break;
      case "order":  this._tone("square", 620, 760, 0.045, 0.035); break;
      case "error":  this._tone("square", 180, 140, 0.10, 0.06); break;

      // territory
      case "capture":                                                     // little up-fanfare
        this._tone("square", 523, 523, 0.07, 0.06);
        this._tone("square", 659, 659, 0.07, 0.06, 0.07);
        this._tone("square", 784, 784, 0.12, 0.07, 0.14);
        break;
      case "lost":                                                        // descending alarm
        this._tone("sawtooth", 600, 600, 0.12, 0.05);
        this._tone("sawtooth", 420, 420, 0.16, 0.05, 0.13);
        break;
      case "rankup":
        this._tone("square", 660, 660, 0.05, 0.05);
        this._tone("square", 880, 880, 0.05, 0.05, 0.05);
        this._tone("square", 1100, 1100, 0.09, 0.05, 0.10);
        break;
    }
  },

  // world-positioned effects fade with distance from the camera centre
  playAt(name, x, y, intensity = 1) {
    if (!this.ctx || this.muted) return;
    const cx = G.cam.x + CFG.VIEW_W / 2, cy = G.cam.y + CFG.VIEW_H / 2;
    const d = Util.dist(x, y, cx, cy);
    const fall = Util.clamp(1 - (d - 300) / 700, 0.15, 1);
    this.play(name, intensity * fall);
  },
};
