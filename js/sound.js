export class SoundFX {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  playTone(freq, type = 'sine', duration = 0.12, gainVal = 0.15, delay = 0) {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;
    const now = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + duration);
  }

  diceShake() {
    for (let i = 0; i < 4; i++) {
      this.playTone(220 + i * 55, 'triangle', 0.05, 0.12, i * 0.06);
    }
  }

  diceLand(val) {
    this.playTone(val === 6 ? 660 : 420, 'sine', 0.14, 0.18);
    if (val === 6) this.playTone(880, 'triangle', 0.22, 0.18, 0.08);
  }

  step() {
    this.playTone(520, 'sine', 0.055, 0.12);
  }

  safeZone() {
    this.playTone(587.33, 'sine', 0.14, 0.15, 0);
    this.playTone(880, 'sine', 0.22, 0.15, 0.09);
  }

  capture() {
    this.playTone(320, 'sawtooth', 0.12, 0.18, 0);
    this.playTone(180, 'sawtooth', 0.25, 0.2, 0.08);
  }

  homeGoal() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, idx) => {
      this.playTone(f, 'triangle', 0.22, 0.18, idx * 0.08);
    });
  }

  coin() {
    this.playTone(987.77, 'sine', 0.1, 0.16, 0);
    this.playTone(1318.51, 'sine', 0.24, 0.16, 0.07);
  }

  tickWarn() {
    this.playTone(760, 'sine', 0.06, 0.09);
  }

  eliminate() {
    this.playTone(240, 'sawtooth', 0.2, 0.2, 0);
    this.playTone(150, 'sawtooth', 0.35, 0.22, 0.15);
  }

  winFanfare() {
    [523.25, 659.25, 783.99, 1046.5].forEach((n, i) => {
      this.playTone(n, 'triangle', 0.25, 0.2, i * 0.12);
    });
  }
}

export const sfx = new SoundFX();
