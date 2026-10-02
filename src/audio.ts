/** Original, procedural adventure-game effects. No samples, music or autoplay. */
type SoundKind = 'click' | 'pickup' | 'steal' | 'deliver' | 'ability' | 'denied' | 'step' | 'discover';
type AudioGlobals = typeof globalThis & { webkitAudioContext?: typeof AudioContext };

const PREFERENCE_KEY = 'cards-audio';
const MASTER_VOLUME = 0.36;
const note = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export class GameAudio {
  private _enabled = true;
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private active = new Set<AudioScheduledSourceNode>();
  private lastPlayed = new Map<SoundKind, number>();
  private stepSide = 1;
  private unlocking: Promise<void> | null = null;

  constructor() {
    try {
      const preference = globalThis.localStorage?.getItem(PREFERENCE_KEY);
      this._enabled = preference !== 'off' && preference !== 'false' && preference !== '0';
    } catch { /* Storage may be unavailable in privacy-restricted browsing. */ }
  }

  get enabled() { return this._enabled; }

  setEnabled(enabled: boolean) {
    this._enabled = Boolean(enabled);
    try { globalThis.localStorage?.setItem(PREFERENCE_KEY, this._enabled ? 'on' : 'off'); } catch { /* Preference remains effective for this session. */ }
    try {
      const ctx = this.context;
      if (ctx && this.master) {
        const now = ctx.currentTime;
        const gain = this.master.gain;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(gain.value, now);
        gain.linearRampToValueAtTime(this._enabled ? MASTER_VOLUME : 0, now + 0.018);
        if (!this._enabled) {
          // Discard future arpeggio notes as well: unmuting never replays a cue.
          for (const source of this.active) { try { source.stop(now + 0.022); } catch { /* Already ended. */ } }
          this.lastPlayed.clear();
        }
      }
    } catch { /* Sound support must never interfere with the game. */ }
  }

  /** Call from a trusted pointer/key interaction; deliberately never called by SFX methods. */
  async unlock(): Promise<void> {
    if (!this._enabled) return;
    if (this.unlocking) return this.unlocking;
    // This guard also makes accidental startup calls silent. Browsers lacking
    // UserActivation still enforce their own AudioContext gesture policy.
    if (typeof navigator !== 'undefined' && navigator.userActivation
      && !navigator.userActivation.isActive && !navigator.userActivation.hasBeenActive) return;
    this.unlocking = this.initialize();
    try { await this.unlocking; } finally { this.unlocking = null; }
  }

  private async initialize() {
    try {
      if (!this.context || this.context.state === 'closed') {
        const AudioAPI = (globalThis as AudioGlobals).AudioContext ?? (globalThis as AudioGlobals).webkitAudioContext;
        if (!AudioAPI) return;
        const ctx = new AudioAPI({ latencyHint: 'interactive' });
        const gain = ctx.createGain();
        const compressor = ctx.createDynamicsCompressor();
        gain.gain.value = this._enabled ? MASTER_VOLUME : 0;
        compressor.threshold.value = -20;
        compressor.knee.value = 18;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.14;
        gain.connect(compressor); compressor.connect(ctx.destination);
        const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.7), ctx.sampleRate);
        const data = buffer.getChannelData(0);
        // A bounded, reusable noise bed for fabric swishes and earthy footsteps.
        let seed = 0x54a92d17;
        for (let i = 0; i < data.length; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          data[i] = (seed / 0xffffffff) * 2 - 1;
        }
        this.context = ctx; this.master = gain; this.compressor = compressor; this.noiseBuffer = buffer;
        this.lastPlayed.clear();
      }
      if (this.context.state !== 'running') await this.context.resume();
    } catch {
      // Unsupported/suspended audio remains silent; UI and gameplay still work.
    }
  }

  private play(kind: SoundKind, cooldown: number, effect: (ctx: AudioContext, at: number) => void) {
    const ctx = this.context;
    if (!this._enabled || !ctx || ctx.state !== 'running' || !this.master) return;
    const now = ctx.currentTime;
    if (now - (this.lastPlayed.get(kind) ?? -Infinity) < cooldown) return;
    this.lastPlayed.set(kind, now);
    try { effect(ctx, now + 0.006); } catch { /* A sound failure is never a gameplay failure. */ }
  }

  private envelope(ctx: AudioContext, start: number, duration: number, volume: number, attack = 0.006) {
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(volume, start + Math.min(attack, duration / 3));
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    return envelope;
  }

  private output(ctx: AudioContext, envelope: GainNode, pan: number): AudioNode[] {
    if (pan && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner(); panner.pan.value = pan;
      envelope.connect(panner); panner.connect(this.master!); return [envelope, panner];
    }
    envelope.connect(this.master!); return [envelope];
  }

  private manage(source: AudioScheduledSourceNode, nodes: AudioNode[], start: number, stop: number) {
    this.active.add(source);
    source.onended = () => {
      this.active.delete(source);
      try { source.disconnect(); for (const node of nodes) node.disconnect(); } catch { /* Context may already have been closed. */ }
    };
    source.start(start); source.stop(stop);
  }

  private tone(ctx: AudioContext, start: number, frequency: number, duration: number, volume: number,
    type: OscillatorType = 'triangle', endFrequency = frequency, pan = 0) {
    const oscillator = ctx.createOscillator(); oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (endFrequency !== frequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration * 0.85);
    const envelope = this.envelope(ctx, start, duration, volume);
    oscillator.connect(envelope);
    this.manage(oscillator, this.output(ctx, envelope, pan), start, start + duration + 0.012);
  }

  private noise(ctx: AudioContext, start: number, duration: number, volume: number,
    frequency: number, endFrequency = frequency, pan = 0, filterType: BiquadFilterType = 'bandpass') {
    if (!this.noiseBuffer) return;
    const source = ctx.createBufferSource(); source.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter(); filter.type = filterType; filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(frequency, start);
    filter.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
    const envelope = this.envelope(ctx, start, duration, volume, 0.009);
    source.connect(filter); filter.connect(envelope);
    this.manage(source, [filter, ...this.output(ctx, envelope, pan)], start, start + duration + 0.012);
  }

  click() {
    this.play('click', 0.045, (ctx, at) => {
      this.tone(ctx, at, 740, 0.045, 0.075, 'sine', 920);
      this.tone(ctx, at + 0.025, 1480, 0.045, 0.026, 'triangle');
    });
  }

  pickup() {
    this.play('pickup', 0.14, (ctx, at) => {
      // Four bright original intervals, with a soft foil-like shimmer.
      for (const [index, midi] of [74, 78, 81, 88].entries()) {
        this.tone(ctx, at + index * 0.047, note(midi), 0.17, 0.11 - index * 0.014, 'triangle', note(midi), (index - 1.5) * 0.12);
      }
      this.noise(ctx, at, 0.115, 0.045, 4700, 6600);
      this.tone(ctx, at + 0.14, note(88), 0.26, 0.028, 'sine');
    });
  }
  discover() {
    this.play('discover', 2, (ctx, at) => {
      this.tone(ctx, at, note(81), .22, .07, 'sine');
      this.tone(ctx, at + .12, note(88), .3, .06, 'sine');
    });
  }

  steal() {
    this.play('steal', 0.2, (ctx, at) => {
      this.noise(ctx, at, 0.19, 0.16, 500, 3100, -0.25);
      this.tone(ctx, at, 240, 0.13, 0.07, 'triangle', 130);
      this.tone(ctx, at + 0.055, note(69), 0.115, 0.1, 'square', note(71));
      this.tone(ctx, at + 0.15, note(83), 0.19, 0.095, 'triangle', note(83), 0.2);
    });
  }

  deliver() {
    this.play('deliver', 0.65, (ctx, at) => {
      for (const [index, midi] of [62, 66, 69, 74, 78, 81].entries()) {
        this.tone(ctx, at + index * 0.067, note(midi), 0.29, 0.105 - index * 0.008, 'triangle', note(midi), (index % 2 ? 1 : -1) * 0.2);
      }
      this.tone(ctx, at + 0.29, note(74), 0.43, 0.06, 'sine', note(74), -0.2);
      this.tone(ctx, at + 0.29, note(81), 0.43, 0.045, 'sine', note(81), 0.2);
      this.tone(ctx, at + 0.43, note(90), 0.33, 0.028, 'triangle');
      this.noise(ctx, at + 0.27, 0.22, 0.035, 5300, 7200);
    });
  }

  ability(kind: 'radar' | 'dash') {
    this.play('ability', 0.3, (ctx, at) => {
      if (kind === 'radar') {
        for (const [index, delay] of [0, 0.14, 0.28].entries()) {
          this.tone(ctx, at + delay, note(86), 0.18, 0.095 / (index + 1), 'sine', note(86) * 0.985, (index - 1) * 0.22);
          this.tone(ctx, at + delay + 0.025, note(93), 0.10, 0.027 / (index + 1), 'triangle');
        }
      } else if (kind === 'dash') {
        this.noise(ctx, at, 0.29, 0.17, 550, 3400, 0, 'bandpass');
        this.noise(ctx, at + 0.05, 0.19, 0.075, 2600, 450, 0, 'lowpass');
        this.tone(ctx, at, 145, 0.15, 0.1, 'sine', 52);
        this.tone(ctx, at + 0.035, 420, 0.17, 0.038, 'triangle', 1100);
      }
    });
  }

  denied() {
    this.play('denied', 0.3, (ctx, at) => {
      this.tone(ctx, at, note(55), 0.095, 0.095, 'triangle');
      this.tone(ctx, at + 0.1, note(52), 0.13, 0.085, 'triangle');
      this.noise(ctx, at, 0.035, 0.022, 650, 380);
    });
  }

  /** Call while actual movement occurs. Timing is limited internally, independent of frame rate. */
  step(sprinting = false) {
    this.play('step', sprinting ? 0.205 : 0.305, (ctx, at) => {
      this.stepSide *= -1;
      const pan = this.stepSide * 0.24;
      this.noise(ctx, at, sprinting ? 0.075 : 0.065, sprinting ? 0.072 : 0.046,
        this.stepSide > 0 ? 790 : 670, 280, pan, 'lowpass');
      this.tone(ctx, at, this.stepSide > 0 ? 116 : 104, 0.07, sprinting ? 0.063 : 0.045, 'sine', 48, pan);
    });
  }

  /** Optional cleanup for app teardown; it never changes the saved sound preference. */
  dispose() {
    for (const source of this.active) { try { source.stop(); } catch { /* Already ended. */ } }
    this.active.clear(); this.lastPlayed.clear();
    try { this.master?.disconnect(); this.compressor?.disconnect(); void this.context?.close().catch(() => {}); } catch { /* Already closed or unsupported. */ }
    this.context = null; this.master = null; this.compressor = null; this.noiseBuffer = null;
  }
}
