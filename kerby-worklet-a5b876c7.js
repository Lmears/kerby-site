// KerBy's engine for kerby.slypork.net, built by kerby-promo/reels/shop/site.py from engine.js and worklet.js. Don't edit it.
// The KerBy web engine's JavaScript side: instantiates build/kerby.wasm and wraps its C functions
// (engine/kerby_web.cpp). Written for an AudioWorkletGlobalScope, which has no fetch, DOM or
// (in some browsers) TextDecoder, so it takes the module's bytes and decodes strings itself.
// The page's worklet imports it; so does test-engine.mjs under Node.

const ENOSYS = 52; // WASI's "not implemented": the demo has no files, environment or console

function readUtf8(bytes, start) {
    let end = start;
    while (bytes[end] !== 0) end++;
    let text = '';
    for (let i = start; i < end;) {
        const b = bytes[i++];
        let code;
        if (b < 0x80) code = b;
        else if (b < 0xe0) code = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
        else if (b < 0xf0) code = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        else code = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        text += String.fromCodePoint(code);
    }
    return text;
}

class KerByEngine {
    /** Instantiates the engine from the bytes of kerby.wasm, at the AudioContext's sample rate. */
    static async create(wasmBytes, sampleRate, blockSize = 128) {
        const engine = new KerByEngine();
        await engine.#instantiate(wasmBytes);
        engine.#init(sampleRate, blockSize);
        return engine;
    }

    #exports;
    #memory;
    blockSize = 128;
    channels = 2;
    /** { parameters: [{ index, id, name, min, max, steps, default, choices? }], presets: [path] } */
    description;
    #ids = new Map();

    async #instantiate(wasmBytes) {
        const view = () => new DataView(this.#memory.buffer);
        const syscall = () => -ENOSYS;
        const wasi = {
            proc_exit: code => { throw new Error(`KerBy engine exited (${code})`); },
            fd_write: (fd, iovs, count, written) => {
                // Only diagnostics reach here (stdout, stderr): count them as written and drop them.
                let total = 0;
                for (let i = 0; i < count; i++) total += view().getUint32(iovs + i * 8 + 4, true);
                view().setUint32(written, total, true);
                return 0;
            },
            fd_read: () => ENOSYS, fd_close: () => ENOSYS, fd_seek: () => ENOSYS, fd_sync: () => ENOSYS,
            environ_sizes_get: (count, size) => {
                view().setUint32(count, 0, true);
                view().setUint32(size, 0, true);
                return 0;
            },
            environ_get: () => 0,
            clock_time_get: (id, precision, out) => {
                view().setBigUint64(out, BigInt(Math.round(Date.now() * 1e6)), true);
                return 0;
            },
        };
        const env = new Proxy({ emscripten_notify_memory_growth: () => {}, js_sin: Math.sin, js_cos: Math.cos, js_tan: Math.tan, js_atan: Math.atan, js_atan2: Math.atan2, js_exp: Math.exp, js_expm1: Math.expm1, js_log: Math.log, js_log2: Math.log2, js_log10: Math.log10, js_pow: Math.pow, js_tanh: Math.tanh }, {
            get: (target, name) => target[name] ?? syscall, // __syscall_*: no file system
        });
        const { instance } = await WebAssembly.instantiate(wasmBytes, { wasi_snapshot_preview1: wasi, env });
        this.#exports = instance.exports;
        this.#memory = instance.exports.memory;
        this.#exports._initialize();
    }

    #init(sampleRate, blockSize) {
        this.blockSize = blockSize;
        this.channels = this.#exports.kerby_create(sampleRate, blockSize);
        this.description = JSON.parse(this.#string(this.#exports.kerby_describe()));
        for (const p of this.description.parameters) this.#ids.set(p.id, p.index);
        this.scopeSize = this.#exports.kerby_scope_size();
    }

    #string(pointer) {
        return readUtf8(new Uint8Array(this.#memory.buffer), pointer);
    }

    #floats(pointer, length) {
        // A fresh view each time: the memory's buffer is replaced whenever the module grows it.
        return new Float32Array(this.#memory.buffer, pointer, length);
    }

    /** Renders one block into `outputs` (an array of Float32Arrays, one per channel). */
    process(outputs) {
        this.#exports.kerby_process();
        for (let c = 0; c < outputs.length; c++)
            outputs[c].set(this.#floats(this.#exports.kerby_output(Math.min(c, this.channels - 1)), this.blockSize));
    }

    noteOn(note, velocity = 100) { this.#exports.kerby_note_on(note, velocity); }
    noteOff(note) { this.#exports.kerby_note_off(note); }

    /** Tempo in BPM, and whether the transport runs; starting it goes back to the top of the bar. */
    setTransport(bpm, playing) { this.#exports.kerby_set_transport(bpm, playing ? 1 : 0); }

    /** Nonblocking transition, driven between process() calls by the worklet. */
    beginPresetChange() { return this.#exports.kerby_begin_preset_change() === 1; }
    presetChangeReady() { return this.#exports.kerby_preset_change_ready() === 1; }
    finishPresetChange() { this.#exports.kerby_finish_preset_change(); }

    /** A demo preset by its index in description.presets, or -1 for Init. */
    loadPreset(index) { return this.#exports.kerby_load_preset(index) === 1; }

    /** A parameter's plain value (a Rate's division index, a Glitch amount), by ID. */
    get(id) { return this.#exports.kerby_get_parameter(this.#ids.get(id)); }
    set(id, value) { this.#exports.kerby_set_parameter(this.#ids.get(id), value); }
    text(id) { return this.#string(this.#exports.kerby_parameter_text(this.#ids.get(id))); }

    /** A voice's Rate slots ('kick' or 'bass') as the plugin labels them: [{ label, skipped }]. */
    rateSlots(voice) { return JSON.parse(this.#string(this.#exports.kerby_rate_slots(voice === 'kick' ? 0 : 1))); }

    /** A voice's scope: its last bar, scopeSize signed samples (a view: copy it to keep it). */
    scope(voice) { return this.#floats(this.#exports.kerby_scope(voice === 'kick' ? 0 : 1), this.scopeSize); }

    /** A control's modulation ring, by ID, as 0..1 of its travel: { low, high, now } (now -1 while
        nothing moves it this block), or null where no route reaches it. */
    modulation(id) {
        const [low, high, now] = this.#floats(this.#exports.kerby_modulation(this.#ids.get(id)), 3);
        return low < 0 ? null : { low, high, now };
    }

    /** Both voices cleared: the hits under way, the held notes, the reverb's tail and the duck. */
    reset() { this.#exports.kerby_reset(); }

    /** The random LFOs from this seed, for a test that needs two engines to roll the same (handheld-engine.mjs). */
    seed(value) { this.#exports.kerby_seed(value); }

    /** The engine at another rate and block size, its patch kept and what was sounding cleared. */
    setRate(sampleRate, blockSize) {
        this.#exports.kerby_set_rate(sampleRate, blockSize);
        this.blockSize = blockSize;
    }

    /** How many times a voice fired in the last block: its pulses and its Glitch rolls. */
    fired(voice) { return this.#exports.kerby_fired(voice === 'kick' ? 0 : 1); }

    /** How long until a voice's next hit, in milliseconds, up to two seconds. */
    nextHit(voice) { return this.#exports.kerby_next_hit(voice === 'kick' ? 0 : 1); }

    /** How much of the hit a voice just fired gets through the duck, at its most, from 0 to 1. */
    hitLevel(voice) { return this.#exports.kerby_hit_level(voice === 'kick' ? 0 : 1); }

    /** A voice's line across the bar: `count` values of whichever of each point's extremes came
        first, then `count` of the other (a view: copy it to keep it). Nothing yet ahead of a new take's clock. */
    line(voice, count) { return this.#floats(this.#exports.kerby_scope_line(voice === 'kick' ? 0 : 1, count), count * 2); }

    /** The house button: Return Home. */
    goHome() { this.#exports.kerby_go_home(); }
}
// The KerBy demo's audio thread: KerBy's own engine (kerby.wasm, through engine.js), rendering
// 128 frames at a time. The page sends it notes, tempo and control changes; it sends back the
// values the page draws (after a preset or Return Home moves them) and the two voices' scopes.
//
// The engine's clock runs while Play is on or a key is held. A key pressed with nothing else
// sounding starts it from the top of the bar, as pressing a note at bar 1 with Live playing does,
// so a patch whose modulators follow the transport (Dubstep's wobble) plays the same whenever the
// key goes down, instead of carrying on from wherever its free-running LFOs had got to.
//
// engine.js and kerby.wasm are built in the slypork-plugins repository (web/kerby-demo, `build.sh
// install`); don't edit them here.

// The controls the page shows. Their values come back after anything that can move them.
const SHOWN = ['KICK_RATE', 'BASS_RATE', 'KICK_GLITCH', 'BASS_GLITCH', 'KICK_RATE_ON', 'BASS_RATE_ON'];
// The knobs, whose modulation rings (a preset's routes, Acid Glitch's random LFO on Kick Rate) come
// back with every scope update, and once after a preset or Return Home.
const KNOBS = ['KICK_RATE', 'BASS_RATE', 'KICK_GLITCH', 'BASS_GLITCH'];
const BLOCK = 128;
const SCOPE_POINTS = 512; // the page's scopes: the engine's 2048-bucket bar, four buckets a point
const SCOPE_EVERY = 8;    // blocks between scope updates: about 40 a second at 44.1 or 48 kHz
// Less of a hit than this gets through the duck, and it's lost under it, so it lights nothing (kerby_hit_level).
const HEARD = 0.1;
const QUIET_BLOCKS = Math.ceil(sampleRate / 2 / BLOCK); // half a second of silence is quiet
// Before every shot, let Enabled gain settle in both directions (PulseVoice gainSmoothingSeconds is 20 ms).
// The same after a shot puts them back: a key or Play waits that long, and so does the page's sleep.
const SHOT_FADE = Math.ceil(sampleRate * .03 / BLOCK);
const SHOT_LONGEST = Math.ceil(sampleRate * 2 / BLOCK); // a step lane that lets nothing through: let go anyway
const SHOT_MOVES = ['KICK_ENABLED', 'BASS_ENABLED', 'BASS_DUCK_ON']; // what a shot sets aside, and puts back
const SILENT = 1e-5;      // -100 dBFS
// A device that can't render the engine at the context's rate gets it at half, and at a quarter if that's still too
// much, with the samples between filled in here (Doubler, fill()). What goes is the top: at half of 48 kHz, what's
// above 9 kHz, which in the demo's presets is from 26 dB under the whole (Kerb Stomper's) to 74 (Init's); at a
// quarter, what's above 4.5 kHz, 22 dB under at most. The other choice is crackle. The worklet finds out by the
// clock (watchClock()), and from what the warm-up cost.
const BLOCK_MS = BLOCK / sampleRate * 1000;
const WATCH_BLOCKS = Math.ceil(sampleRate / 4 / BLOCK); // a quarter of a second: the stretch the clock is read over
const LATE_MS = 5;      // a stretch ending this much further behind the clock than the one before has dropped out
const FORGET = 8;       // stretches, 2 s: two that dropped out no further apart than this, and the rate is halved
const STALLED_MS = 100; // this long between two blocks is the context suspended or the device stalling, not the engine
const BUSY = 0.5;       // of the time a stretch's blocks had, spent rendering them: under it, what dropped out wasn't the engine's doing
const LAGGED_MS = 5;    // nor was it unless the rendering itself got this far behind the blocks it was rendering
// The rate it starts at, from what the warm-up found a block will cost (warmUp()): the full rate if that's under ROOM
// of the time a block has; or else half, unless at half it would still be over CROWDED, and then a quarter. It's
// the mean of the presets: the heaviest costs a third more, and a first note more again, so a mean of 0.4 has a
// first note near 0.8. Half gets the higher bar because a quarter gives up more of the sound; the clock is still
// watched after (watchClock()).
const ROOM = 0.4;
const CROWDED = 0.55;
const HALF_COSTS = 0.7; // what a block costs at half the rate, of what it does at the full one (measured: 0.69)
const SLOWEST = 4;      // a quarter of the context's rate, and no lower
// A context that was running while the warm-up had its thread (a tap came during the load) has blocks owing, and
// Chrome and Safari then ask for every one of them at once: 980 blocks after 2.5 s (README, "A tap during the
// load"). They're given silence, which costs nothing, until the first pause between two blocks or this long.
const OWED_LONGEST = 250;
const REHEARSAL = 40;   // blocks of a held note through fill(), before the page gets an engine at a lower rate
// A half-band filter's taps either side of the middle, the ones that aren't 0: a Kaiser-windowed sinc, flat within
// 0.01 dB to 0.38 of the lower rate, and what it adds above 0.62 of it 80 dB down (handheld-engine.mjs measures both).
const HALF_BAND = (() => {
    const pairs = 12, beta = 8;
    const bessel = x => {
        let sum = 1, term = 1;
        for (let k = 1; k < 40; k++) {
            term *= (x / (2 * k)) ** 2;
            sum += term;
        }
        return sum;
    };
    const taps = new Float64Array(pairs);
    let sum = 0;
    for (let k = 0; k < pairs; k++) {
        const away = 2 * k + 1; // samples from the middle, at the doubled rate
        taps[k] = (k % 2 ? -1 : 1) * 2 / (Math.PI * away) * bessel(beta * Math.sqrt(1 - (away / (2 * pairs)) ** 2)) / bessel(beta);
        sum += taps[k];
    }
    return taps.map(tap => tap / (2 * sum)); // a steady level comes out as it went in
})();

/** Twice the samples: each one in, then the one that belongs between it and the next, from the twelve either side. */
class Doubler {
    constructor(block) {
        this.line = new Float32Array(2 * HALF_BAND.length - 1 + block); // the last 23 samples in, then a block's
    }

    run(input, output) {
        const pairs = HALF_BAND.length, line = this.line;
        line.set(input, 2 * pairs - 1);
        for (let i = 0; i < input.length; i++) {
            let between = 0;
            for (let k = 0; k < pairs; k++) between += HALF_BAND[k] * (line[i + pairs - 1 - k] + line[i + pairs + k]);
            output[2 * i] = line[i + pairs - 1];
            output[2 * i + 1] = between;
        }
        line.copyWithin(0, input.length);
    }
}

class KerByWorklet extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.engine = null;
        this.waiting = [];
        this.blocks = 0;
        this.scopeBlocksLeft = 0;
        this.ringsDue = false; // the rings to send after the next block: a new patch's routes have run once by then
        this.playing = false; // the page's Play
        this.held = new Set();
        this.bpm = 128;
        this.heard = 0;       // messages from the page, for it to match a quiet against what it's sent
        this.quietBlocks = 0; // silent blocks since the last sound or message
        this.settling = 0;    // blocks until what a shot put back has faded in
        this.waitingToPlay = []; // messages held till then (handle())
        this.divide = 1;      // the context's rate over the engine's: 1, 2 or 4 (halve())
        this.small = null;    // the engine's block at its lower rate
        this.stages = [];     // from the engine's rate up to the context's: a Doubler a channel, and where it writes
        this.halveDue = false; // a halving asked for while a preset was changing (halve())
        this.timedBy = false; // whether the clock's steps are fine enough to time by (warmUp()'s clockStep)
        this.behind = null;   // how far behind the clock the blocks are running (watchClock())
        this.late = 0;        // stretches that dropped out, and the milliseconds that went with them, for the readout
        this.lost = 0;
        this.ours = 0;        // and how many of them the engine was busy through: the ones that can halve it
        this.owed = null;     // after the warm-up: when the last block was asked for, and when to stop asking (owing())
        this.dozing = false;  // between saying it's quiet and the page's next message: the context may be asleep
        this.port.onmessage = event => {
            this.heard++;
            this.quietBlocks = 0;
            this.dozing = false;
            this.engine ? this.handle(event.data) : this.waiting.push(event.data);
        };
        KerByEngine.create(options.processorOptions.wasm, sampleRate, BLOCK).then(engine => {
            this.engine = engine;
            this.timedBy = engine.clockStep <= 2;
            if (engine.warmUpCost > ROOM * BLOCK_MS) this.halve();
            if (engine.warmUpCost * HALF_COSTS > CROWDED * BLOCK_MS) this.halve();
            if (this.divide > 1) this.rehearse();
            const now = Date.now();
            if (this.timedBy) this.owed = { last: now, until: now + OWED_LONGEST, pause: engine.clockStep };
            this.port.postMessage({ type: 'ready', presets: engine.description.presets, ...this.state() });
            this.port.postMessage({ type: 'rate', divide: this.divide, cost: engine.warmUpCost, settled: engine.warmUpSettled, step: engine.clockStep });
            this.ringsDue = true;
            for (const message of this.waiting) this.handle(message);
            this.waiting = [];
        }, error => this.port.postMessage({ type: 'error', message: String(error) }));
    }

    state() {
        const values = {};
        for (const id of SHOWN) values[id] = this.engine.get(id);
        return { values, slots: { kick: this.engine.rateSlots('kick'), bass: this.engine.rateSlots('bass') } };
    }

    /** Runs the engine's clock while Play is on or a key is held; starting it goes to the top of the bar. */
    runClock() {
        this.engine.setTransport(this.bpm, this.playing || this.held.size > 0);
    }

    settleScopes() {
        if (this.playing || this.held.size) this.scopeBlocksLeft = Infinity;
        else if (this.scopeBlocksLeft === Infinity) this.scopeBlocksLeft = Math.ceil(sampleRate / BLOCK);
    }

    handle(message) {
        if (this.switching) {
            if (message.type === 'preset') this.switching = { message, after: [] };
            else this.switching.after.push(message);
            return;
        }
        if (message.type === 'preset' && this.engine.beginPresetChange()) {
            this.switching = { message, after: [] };
            return;
        }
        this.applyMessage(message);
    }

    applyMessage(message) {
        const engine = this.engine;
        if (this.shot) {
            // One of the settings a shot moved is kept, to put back with the rest: the page sends its duck after
            // every preset, the engine's first among them, so a tap as the engine starts would lose its shot.
            if (message.type === 'set' && message.id in this.shot.put) {
                this.shot.put[message.id] = message.value;
                return;
            }
            // Anything that would play over it or set a new patch: what it moved goes back first. Other settings, a
            // key let go or a new tempo leave it be, and another shot takes over from it (startShot()).
            if (!['set', 'note-off', 'shot'].includes(message.type) && !(message.type === 'transport' && !message.playing))
                this.endShot();
        }
        // What a shot put back fades in for SHOT_FADE: a key or Play waits for it, or its first kick would fade in
        // too (Kick, pig, cab, then a key). Whatever comes after one waiting waits as well, to keep the order.
        if (this.settling > 0 && (this.waitingToPlay.length || message.type === 'note-on' || (message.type === 'transport' && message.playing))) {
            this.waitingToPlay.push(message);
            return;
        }
        if (message.type === 'shot') return this.startShot(message);
        switch (message.type) {
            // The scopes run while Play is on or a key is held, and a second after both stop, to let
            // the last bar draw.
            case 'note-on':
                this.held.add(message.note);
                this.runClock();
                engine.noteOn(message.note, message.velocity ?? 100);
                this.scopeBlocksLeft = Infinity;
                break;
            case 'note-off':
                engine.noteOff(message.note);
                this.held.delete(message.note);
                this.runClock();
                this.settleScopes();
                break;
            case 'transport':
                this.bpm = message.bpm;
                this.playing = message.playing;
                this.runClock();
                this.settleScopes();
                break;
            case 'set': engine.set(message.id, message.value); break;
            case 'preset':
                engine.loadPreset(message.index);
                this.port.postMessage({ type: 'state', preset: true, ...this.state() });
                this.ringsDue = true;
                break;
            case 'halve': this.halve(); break; // by hand, to hear the lower rate or test it: root.kbSend({ type: 'halve' })
            case 'home':
                engine.goHome();
                this.port.postMessage({ type: 'state', ...this.state() });
                this.ringsDue = true;
                break;
        }
    }

    /** One hit of a voice on its own ('kick', 'bass'), or of both together ('both', the pig's), as a note from silence
        plays it: each voice's first hit its step lane lets through, from the top of the bar, and nothing of a voice left
        out. That one's muted, and the duck switched off, a fade's length before the note goes down. A voice brought
        back also gets that time, so its first transient isn't faded in. The note is let go once each voice has fired,
        so each fires once and rings out.
        Only from silence: never over a key or Play. A shot asked for while one's going takes over from it, keeping what
        that one set aside, so a run of clicks plays a hit each, however fast. What it moved goes back once all is
        quiet, a muted voice's hit long over by then, or before a key, Play, a preset or Home. */
    startShot({ voice, note }) {
        const was = this.shot;
        this.shot = null;
        if (was?.down) this.letGo(was);
        if (this.playing || this.held.size) {
            if (was) this.putBack(was.put);
            return;
        }
        const put = was ? was.put : {};
        for (const id of SHOT_MOVES) if (!(id in put)) put[id] = this.engine.get(id);
        // the voices asked for, as the patch has them: one it has switched off plays nothing
        const voices = (voice === 'both' ? ['kick', 'bass'] : [voice]).filter(v => put[v.toUpperCase() + '_ENABLED']);
        for (const id of SHOT_MOVES) {
            const value = voices.some(v => id === v.toUpperCase() + '_ENABLED') ? put[id] : 0;
            this.engine.set(id, value);
        }
        this.shot = { asked: voice, voices, note, put, wait: SHOT_FADE, down: false, fired: new Set(), blocks: 0 };
    }

    followShot() {
        const shot = this.shot;
        if (shot.wait > 0) {
            if (--shot.wait > 0) return;
            shot.down = true;
            this.held.add(shot.note);
            this.runClock();
            this.engine.noteOn(shot.note, 100);
            this.scopeBlocksLeft = Infinity;
            return;
        }
        if (!shot.down) return;
        for (const v of shot.voices) if (this.engine.fired(v)) shot.fired.add(v);
        // Let go once each has fired; or as one that has is about to fire again, if the other's first is later still
        // (both, on a patch whose bass waits for an offbeat behind a fast kick).
        const again = shot.voices.some(v => shot.fired.has(v) && this.engine.nextHit(v) < 2000 * BLOCK / sampleRate);
        if (shot.fired.size === shot.voices.length || again || ++shot.blocks > SHOT_LONGEST) this.letGo(shot);
    }

    letGo(shot) {
        shot.down = false;
        this.engine.noteOff(shot.note);
        this.held.delete(shot.note);
        this.runClock();
        this.settleScopes();
    }

    endShot() {
        const shot = this.shot;
        this.shot = null;
        if (shot.down) this.letGo(shot);
        this.putBack(shot.put);
    }

    /** What a shot moved, back as it was; a key or Play waits SHOT_FADE for it to fade in (handle()). */
    putBack(put) {
        for (const [id, value] of Object.entries(put)) this.engine.set(id, value);
        this.settling = SHOT_FADE;
    }

    process(inputs, outputs) {
        if (this.switching && this.engine.presetChangeReady()) {
            const { message, after } = this.switching;
            this.switching = null;
            this.applyMessage(message);
            this.engine.finishPresetChange();
            for (const waited of after) this.handle(waited);
        }
        const output = outputs[0];
        if (!this.engine || output[0].length !== BLOCK) return true;
        if (this.owed && this.owing()) return true;
        if (this.halveDue && !this.switching) this.halve();
        const from = this.watchClock();
        if (this.divide === 1) this.engine.process(output);
        else this.fill(output);
        if (from && this.behind) this.rendered(Date.now() - from);
        this.reportHits();
        if (this.shot) this.followShot();
        if (this.settling > 0 && --this.settling === 0) {
            const waited = this.waitingToPlay;
            this.waitingToPlay = [];
            for (const message of waited) this.handle(message);
        }
        if (this.scopeBlocksLeft > 0 && ++this.blocks % SCOPE_EVERY === 0) {
            this.scopeBlocksLeft -= SCOPE_EVERY;
            const kick = this.engine.line('kick', SCOPE_POINTS).slice();
            const bass = this.engine.line('bass', SCOPE_POINTS).slice();
            this.port.postMessage({ type: 'scope', kick, bass }, [kick.buffer, bass.buffer]);
            this.ringsDue = true;
        }
        if (this.ringsDue) this.sendRings();
        this.listenForQuiet(output);
        return true;
    }

    /** Each knob's modulation ring, as KerBy draws it round a modulated knob: { low, high, now } as
        0..1 of its travel, or null for a knob no route reaches. */
    sendRings() {
        this.ringsDue = false;
        const rings = {};
        for (const id of KNOBS) rings[id] = this.engine.modulation(id);
        this.port.postMessage({ type: 'modulation', rings });
    }

    /** The engine at half the rate it was at, down to a quarter of the context's. It keeps its patch and its place in
        the bar and drops what was sounding (kerby_set_rate), so the keys that are down go down again. Not in the
        middle of a preset's change, which the engine is carrying a bar across: straight after it. */
    halve() {
        if (this.divide >= SLOWEST) return;
        this.halveDue = Boolean(this.switching);
        if (this.halveDue) return;
        this.divide *= 2;
        const block = BLOCK / this.divide;
        this.engine.setRate(sampleRate / this.divide, block);
        this.small = [new Float32Array(block), new Float32Array(block)];
        // The new stage goes first: from the engine's rate up to the one it had.
        this.stages.unshift({ doublers: [new Doubler(block), new Doubler(block)],
                              out: [new Float32Array(block * 2), new Float32Array(block * 2)] });
        for (const note of this.held) this.engine.noteOn(note, 100);
        this.behind = null;
        this.port.postMessage({ type: 'rate', divide: this.divide });
    }

    /** A held note through fill() at the rate just chosen, unheard, before the page gets the engine: the warm-up
        played it at the full rate only, and the first blocks of a loop the browser hasn't compiled yet are its
        slowest. Then silence until the note's tail has gone, as the warm-up leaves it. */
    rehearse() {
        const engine = this.engine, output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
        engine.setTransport(140, true);
        engine.noteOn(36, 100);
        for (let i = 0; i < REHEARSAL; i++) this.fill(output);
        engine.noteOff(36);
        engine.setTransport(140, false);
        engine.reset();
        for (let i = 0, quiet = 0; i < 400 && quiet < 20; i++) {
            this.fill(output);
            quiet = output.every(channel => channel.every(v => Math.abs(v) <= SILENT)) ? quiet + 1 : 0;
        }
    }

    /** Whether this block is one of those owing from the warm-up (OWED_LONGEST): asked for with no pause since the
        last, on a clock of `pause` ms a step. The first that comes after a pause is the device's own, and from
        then on the engine plays. */
    owing() {
        const now = Date.now(), owed = this.owed;
        if (now - owed.last > owed.pause || now > owed.until) {
            this.owed = null;
            return false;
        }
        owed.last = now;
        return true;
    }

    /** A block from the engine at its lower rate, doubled up to the context's. */
    fill(output) {
        this.engine.process(this.small);
        const last = this.stages.length - 1;
        for (let c = 0; c < output.length && c < 2; c++) {
            let samples = this.small[c];
            for (let s = 0; s <= last; s++) {
                const to = s === last ? output[c] : this.stages[s].out[c];
                this.stages[s].doublers[c].run(samples, to);
                samples = to;
            }
        }
    }

    /** Whether the engine is keeping up, by the clock. A device that renders slower than the music plays falls behind:
        each stretch of blocks ends further behind the clock than the last, by the time that dropped out of the sound.
        So, at each block's start, how far the clock has run ahead of the blocks rendered, and the least of that over
        each quarter of a second: the least, because a device asks for blocks several at a time and the last of each
        lot is the one that's on time. The least up by LATE_MS on the stretch before is a stretch that dropped out.
        That's the engine's doing only if the rendering is what fell behind (rendered()): it took BUSY of the time
        the stretch's blocks had, and at some point it was LAGGED_MS behind the blocks it was rendering, each block's
        time over its 2.67 ms added up and paid back by the quick ones. In this stretch or the one before: a slip
        late in a stretch shows in the next one's least. Two of those within FORGET stretches halve the engine's rate
        (halve()). A stretch that dropped out any other way was something else's: a preset loading on this thread
        (3 ms, and up to 12, which Firefox never makes up: two presets chosen within 2 s halved the rate, with
        nothing playing, 12 Nov), the device, another program. A lower rate cures none of those and costs the top of
        the sound for the rest of the visit, so they're counted for the readout and no more. Nor does one heavy
        block in a stretch that's otherwise idle, a note's first, count: at half the rate it's nearly as heavy.
        Nothing brings the rate back up, so it can't hunt between two rates. At a quarter
        there's nothing left to do about it, but it's still counted: each stretch tells the page what a block cost,
        how many stretches have dropped out, how many of those were the engine's and the milliseconds that went with
        them, for its readout. It returns the time it read, for process() to time the block from.
        A gap of STALLED_MS between blocks isn't the engine (the context asleep until a key wakes it, a call, the
        device changing): the count starts again after it, and leaves out its first stretch, as the device settles.
        Nor is the page putting the context to sleep (demo.js's sleep(), on the worklet's 'quiet') and a click waking it
        straight after, though that looks the same from here: Chrome comes back in two pauses, 71 ms and 29 ms, each
        under STALLED_MS, which counted as a stretch dropped out. A click every 0.6 s on the preset arrow, with
        nothing played, had the engine at half the rate after four and a quarter after seven, on an M1 Pro (12 Nov).
        So from 'quiet' until the page's next message nothing is timed (dozing), and the count starts again after it.
        The clock is Date.now(), a millisecond a step; where a browser coarsens it, nothing is timed (timedBy). */
    watchClock() {
        if (!this.timedBy || this.dozing) return 0;
        const now = Date.now(), b = this.behind;
        if (!b || now - b.read > STALLED_MS) {
            this.behind = { read: now, from: now, blocks: 0, least: Infinity, last: null, settled: false, since: Infinity,
                            spent: 0, spentBefore: 0, lag: 0, most: 0, mostBefore: 0 };
            return now;
        }
        b.read = now;
        const ahead = now - b.from - ++b.blocks * BLOCK_MS;
        if (ahead < b.least) b.least = ahead;
        if (b.blocks % WATCH_BLOCKS) return now;
        const late = b.last !== null && b.least - b.last > LATE_MS;
        const ours = late && Math.max(b.spent, b.spentBefore) >= BUSY * WATCH_BLOCKS * BLOCK_MS && Math.max(b.most, b.mostBefore) >= LAGGED_MS;
        if (late) {
            this.late++;
            this.lost += b.least - b.last;
            if (ours) this.ours++;
        }
        this.port.postMessage({ type: 'load', cost: b.spent / WATCH_BLOCKS, late: this.late, lost: this.lost, ours: this.ours });
        b.spentBefore = b.spent;
        b.spent = 0;
        b.mostBefore = b.most;
        b.most = b.lag;
        if (b.settled) b.last = b.least;
        b.settled = true;
        b.least = Infinity;
        if (ours && b.since <= FORGET && this.divide < SLOWEST) {
            this.halve();
            return now;
        }
        b.since = ours ? 0 : b.since + 1;
        return now;
    }

    /** A block took this long to render, by the same clock: the stretch's total, for what a block costs and how busy
        the engine was, and how far the rendering has got behind the blocks it's rendering (lag), which a block
        over its time adds to and a quick one pays back. The clock's steps are a millisecond, so one block reads 0
        or 1 where it took 0.3; over a stretch that comes out right. */
    rendered(ms) {
        const b = this.behind;
        b.spent += ms;
        b.lag = Math.max(0, b.lag + ms - BLOCK_MS);
        if (b.lag > b.most) b.most = b.lag;
    }

    /** Says so once the engine has gone quiet: Play off, no key held, the scopes settled and the
        output silent for half a second, so the reverb's tail has died away. The page suspends the
        context then (demo.js sleep()), so the engine isn't run on silence while the tab is open.
        Again after any message, which may have woken it. */
    listenForQuiet(output) {
        if (this.playing || this.held.size || this.scopeBlocksLeft > 0) { this.quietBlocks = 0; return; }
        if (this.quietBlocks > QUIET_BLOCKS) return;
        for (const channel of output) for (let i = 0; i < channel.length; i++) {
            if (Math.abs(channel[i]) > SILENT) { this.quietBlocks = 0; return; }
        }
        if (++this.quietBlocks > QUIET_BLOCKS) {
            if (this.shot) this.endShot(); // before the page puts the context to sleep
            // and not until what it put back has faded in: asleep, the fade would wait for the next key
            if (this.settling > 0) {
                this.quietBlocks = QUIET_BLOCKS;
                return;
            }
            this.port.postMessage({ type: 'quiet', heard: this.heard });
            // The page suspends the context on that, until its next message: nothing is timed in between
            // (watchClock()), and the count starts again from that message.
            this.dozing = true;
            this.behind = null;
        }
    }

    /** Each voice's hits, from the engine itself, as they fire, stamped with the time the block they fired in plays on
        the context's clock, so the page can draw them as they're heard rather than as they arrive, and with how long
        until the next, so a reaction fits in what it's got; and, for a shot's, which was asked for ('kick', 'bass' or
        'both'), so the page can move only the one of the gang that was clicked. */
    reportHits() {
        for (const voice of ['kick', 'bass'])
            if (this.engine.fired(voice) && this.engine.hitLevel(voice) >= HEARD)
                this.port.postMessage({ type: 'hit', voice, time: currentTime, sent: Date.now(), next: this.engine.nextHit(voice), shot: this.shot ? this.shot.asked : false });
    }
}


{
    const HEAVY_MS = 3, WINDOW = 75, ASLEEP_MS = 100, BEHIND_MS = 3;
    const P = KerByWorklet.prototype, process = P.process, apply = P.applyMessage;
    P.applyMessage = function (message) {
        if (message.type !== 'preset' || !this.meter) return apply.call(this, message);
        const from = Date.now();
        const result = apply.call(this, message);
        this.meter.load = Math.max(this.meter.load, Date.now() - from);
        return result;
    };
    P.process = function (inputs, outputs) {
        const from = Date.now();
        const m = this.meter || (this.meter = { heavy: 0, longest: 0, load: 0, dropped: 0, lost: 0, blocks: 0, start: from, last: from, least: Infinity, before: null });
        // Asleep and woken (the page suspends the context when it's quiet): the clock starts again.
        if (from - m.last > ASLEEP_MS) { m.blocks = 0; m.start = from; m.least = Infinity; m.before = null; }
        m.last = from;
        const result = process.call(this, inputs, outputs);
        const took = Date.now() - from;
        if (took >= HEAVY_MS) m.heavy++;
        if (took > m.longest) m.longest = took;
        const ahead = from - m.start - ++m.blocks * (128000 / sampleRate);
        if (ahead < m.least) m.least = ahead;
        if (m.blocks % WINDOW === 0) {
            if (m.before !== null && m.least - m.before > BEHIND_MS) { m.dropped++; m.lost += m.least - m.before; }
            m.before = m.least;
            m.least = Infinity;
            if (m.blocks % (WINDOW * 5) === 0)
                this.port.postMessage({ type: 'heavy', heavy: m.heavy, longest: m.longest, load: m.load, dropped: m.dropped, lost: m.lost });
        }
        return result;
    };
}
registerProcessor('kerby', KerByWorklet);
