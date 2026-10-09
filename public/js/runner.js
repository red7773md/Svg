// Runs pictures in the browser.
//
// A Session owns one saved picture ("job"). To add a shape it asks a pool of
// Web Workers to search in parallel (each worker tries a share of the hill
// climbs on its own copy of the picture), keeps the best result, and tells
// every worker to apply it so all copies stay identical.
//
// The picture is saved every few shapes, so closing the tab loses almost
// nothing, and an interrupted picture can be resumed on the next visit.

import {
  LIMITS, QUALITY, DETAIL, DEFAULT_QUALITY, DEFAULT_DETAIL, DEFAULT_OPACITY,
  MAX_LOG_LINES, SAVE_EVERY_MS, SAVE_EVERY_SHAPES, THUMB_SIDE,
} from './config.js';
import { analysisPixels } from './imageprep.js';
import { makeThumb, pictureOf } from './exporters.js';
import { matchPercent, plural, formatDuration } from './format.js';

class Emitter {
  constructor() { this.handlers = new Map(); }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }
  emit(type, detail) {
    for (const fn of this.handlers.get(type) || []) {
      try { fn(detail); } catch (err) { console.error(err); }
    }
  }
}

export function clampShapes(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return LIMITS.defaultShapes;
  return Math.min(LIMITS.maxShapes, Math.max(LIMITS.minShapes, n));
}

export function normalizeSettings(s = {}) {
  return {
    shapes: clampShapes(s.shapes ?? LIMITS.defaultShapes),
    mode: Number.isInteger(s.mode) && s.mode >= 0 && s.mode <= 8 ? s.mode : 1,
    quality: QUALITY[s.quality] ? s.quality : DEFAULT_QUALITY,
    detail: DETAIL[s.detail] ? s.detail : DEFAULT_DETAIL,
    opacity: [0, 64, 128, 192, 255].includes(s.opacity) ? s.opacity : DEFAULT_OPACITY,
  };
}

function workerCount() {
  const cores = navigator.hardwareConcurrency || 4;
  return cores <= 2 ? 2 : Math.min(6, cores - 1);
}

const scoreOf = (energy, w, h) => Math.sqrt(energy / (w * h * 4)) / 255;

/** Split `total` hill climbs over `workers`, dropping workers that would get none. */
export function splitClimbs(total, workers) {
  const base = Math.floor(total / workers);
  const extra = total % workers;
  const out = [];
  for (let i = 0; i < workers; i++) out.push(base + (i < extra ? 1 : 0));
  return out;
}

export class Session extends Emitter {
  constructor(record, store) {
    super();
    this.record = record;
    this.store = store;
    this.workers = [];
    this.ready = null;        // promise, set once workers are initialised
    this.energy = null;
    this.stepMs = null;       // smoothed time per shape
    this.pauseRequested = false;
    this.looping = false;
    this.lastSave = 0;
    this.savedCount = record.shapes.length;
    this.saveChain = Promise.resolve();
    this.sessionStart = 0;
    this.messageId = 0;
  }

  get id() { return this.record.id; }
  get status() { return this.record.status; }
  get done() { return this.record.shapes.length >= this.record.settings.shapes; }
  picture() { return pictureOf(this.record); }

  progress() {
    const r = this.record;
    const placed = r.shapes.length;
    const target = r.settings.shapes;
    const remaining = Math.max(0, target - placed);
    return {
      placed,
      target,
      fraction: target ? Math.min(1, placed / target) : 0,
      match: matchPercent(r.score),
      elapsedMs: this.elapsedNow(),
      etaMs: this.record.status === 'running' && this.stepMs ? remaining * this.stepMs : null,
    };
  }

  elapsedNow() {
    const r = this.record;
    return r.elapsedMs + (r.status === 'running' && this.sessionStart ? Date.now() - this.sessionStart : 0);
  }

  log(level, message) {
    const line = { t: Date.now(), level, message };
    this.record.log.push(line);
    if (this.record.log.length > MAX_LOG_LINES) this.record.log.splice(0, this.record.log.length - MAX_LOG_LINES);
    this.emit('log', line);
  }

  setStatus(status) {
    this.record.status = status;
    this.emit('status', status);
  }

  // ------------------------------------------------------------ workers

  async prepare() {
    if (!this.ready) this.ready = this.spawn().catch((err) => { this.ready = null; throw err; });
    return this.ready;
  }

  async spawn() {
    const r = this.record;
    const source = await this.store.getSource(r.id);
    if (!source) throw new Error('The original photo is no longer saved in this browser, so this picture cannot be continued.');
    const pixels = await analysisPixels(source, DETAIL[r.settings.detail].side);
    if (pixels.width !== r.width || pixels.height !== r.height) {
      throw new Error('The saved photo no longer matches this picture.');
    }
    const count = workerCount();
    this.log('info', `Starting ${plural(count, 'worker')}…`);
    const baseSeed = (Math.random() * 0xffffffff) >>> 0;
    const jobs = [];
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
      this.workers.push(worker);
      jobs.push(this.call(worker, {
        type: 'init',
        width: pixels.width,
        height: pixels.height,
        target: pixels.data.buffer.slice(0),
        background: r.background,
        seed: (baseSeed + i * 7919) >>> 0,
      }, 'ready'));
    }
    const [first] = await Promise.all(jobs);
    this.energy = first.energy;
    if (r.shapes.length) {
      this.log('info', `Restoring ${plural(r.shapes.length, 'saved shape')}…`);
      const results = await Promise.all(this.workers.map((w) => this.call(w, { type: 'restore', shapes: r.shapes }, 'restored')));
      this.energy = results[0].energy;
    }
    r.score = scoreOf(this.energy, r.width, r.height);
  }

  /** Send a message and wait for one reply of the expected type. */
  call(worker, message, expect) {
    return new Promise((resolve, reject) => {
      const id = ++this.messageId;
      const onMessage = (event) => {
        const data = event.data;
        if (data.type === 'error' && (data.id === undefined || data.id === id)) {
          cleanup();
          reject(new Error(data.message));
        } else if (data.type === expect && (data.id === undefined || data.id === id)) {
          cleanup();
          resolve(data);
        }
      };
      const onError = (event) => {
        cleanup();
        reject(new Error(event.message || 'A worker stopped unexpectedly.'));
      };
      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ ...message, id });
    });
  }

  terminate() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.ready = null;
  }

  // ------------------------------------------------------------ control

  /** Start or continue building until the shape target is reached. */
  async start() {
    if (this.looping) return;
    if (this.done) { await this.finish(); return; }
    this.pauseRequested = false;
    this.looping = true;
    const resumed = this.record.shapes.length > 0;
    try {
      this.setStatus('running');
      this.sessionStart = Date.now();
      await this.prepare();
      const r = this.record;
      this.log('info', `${resumed ? 'Resuming at' : 'Starting with'} ${plural(r.shapes.length, 'shape')} of ${r.settings.shapes.toLocaleString()}`);
      await this.loop();
    } catch (err) {
      await this.fail(err);
    } finally {
      this.looping = false;
    }
  }

  async loop() {
    const r = this.record;
    const q = QUALITY[r.settings.quality];
    const split = splitClimbs(q.climbs, this.workers.length);
    let lastMilestone = Math.floor((r.shapes.length / r.settings.shapes) * 10);

    while (!this.pauseRequested && r.shapes.length < r.settings.shapes) {
      const began = performance.now();
      const results = await Promise.all(this.workers.map((worker, i) => (split[i] === 0 ? null : this.call(worker, {
        type: 'search',
        options: { mode: r.settings.mode, alpha: r.settings.opacity, candidates: q.candidates, age: 100, climbs: split[i] },
      }, 'result'))));
      let best = null;
      for (const res of results) if (res && (!best || res.energy < best.energy)) best = res;

      for (const worker of this.workers) worker.postMessage({ type: 'apply', shape: best.shape });
      this.energy = best.energy;
      r.shapes.push(best.shape);
      r.score = scoreOf(this.energy, r.width, r.height);
      r.updatedAt = Date.now();

      const ms = performance.now() - began;
      this.stepMs = this.stepMs === null ? ms : this.stepMs * 0.9 + ms * 0.1;
      this.emit('progress', this.progress());

      const milestone = Math.floor((r.shapes.length / r.settings.shapes) * 10);
      if (milestone > lastMilestone && r.shapes.length < r.settings.shapes) {
        lastMilestone = milestone;
        this.log('info', `${milestone * 10}% · ${plural(r.shapes.length, 'shape')} · ${matchPercent(r.score).toFixed(1)}% match`);
      }
      if (r.shapes.length - this.savedCount >= SAVE_EVERY_SHAPES || Date.now() - this.lastSave >= SAVE_EVERY_MS) {
        this.save();
      }
    }

    this.bankElapsed();
    if (r.shapes.length >= r.settings.shapes) await this.finish();
    else await this.pausedNow();
  }

  bankElapsed() {
    if (this.sessionStart) {
      this.record.elapsedMs += Date.now() - this.sessionStart;
      this.sessionStart = 0;
    }
  }

  async finish() {
    const r = this.record;
    this.setStatus('done');
    this.log('ok', `Finished: ${plural(r.shapes.length, 'shape')} · ${matchPercent(r.score).toFixed(1)}% match · ${formatDuration(r.elapsedMs)}`);
    await this.saveNow();
    this.emit('progress', this.progress());
  }

  async pausedNow() {
    this.setStatus('paused');
    this.log('info', `Paused at ${plural(this.record.shapes.length, 'shape')}`);
    await this.saveNow();
  }

  async fail(err) {
    this.bankElapsed();
    this.record.error = err && err.message ? err.message : String(err);
    this.log('error', this.record.error);
    this.terminate();
    this.setStatus('error');
    await this.saveNow();
  }

  /** Ask the loop to stop after the shape it is working on. */
  pause() {
    if (this.looping) this.pauseRequested = true;
  }

  /** Continue a paused, interrupted, or failed picture. */
  async resume() {
    if (this.record.status === 'error') this.record.error = null;
    await this.start();
  }

  /** Raise the shape target of a finished picture and keep building. */
  async addShapes(extra) {
    const r = this.record;
    const target = clampShapes(r.shapes.length + extra);
    if (target <= r.shapes.length) return false;
    r.settings.shapes = target;
    this.log('info', `Adding shapes: new target ${target.toLocaleString()}`);
    await this.start();
    return true;
  }

  // ------------------------------------------------------------- saving

  save() {
    this.lastSave = Date.now();
    this.savedCount = this.record.shapes.length;
    return this.saveNow();
  }

  /** Writes are queued so two saves never overlap. */
  saveNow() {
    this.saveChain = this.saveChain.then(async () => {
      const r = this.record;
      try {
        if (r.shapes.length) r.thumb = await makeThumb(this.picture(), THUMB_SIDE);
        r.updatedAt = Date.now();
        // Store a plain copy so later changes don't race the write.
        await this.store.put({ ...r, log: r.log.slice(), shapes: r.shapes.slice() });
        this.emit('saved', r);
      } catch (err) {
        if (!this.saveWarned) {
          this.saveWarned = true;
          this.log('warn', 'Could not save to this browser (storage may be full). The picture will still finish, but may not be there next visit.');
        }
        console.error(err);
      }
    });
    return this.saveChain;
  }
}

// ------------------------------------------------------------------ manager

const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

/**
 * Keeps track of every picture and makes sure only one builds at a time.
 * (Each build already uses all cores, so running two at once would only slow both.)
 */
export class Manager extends Emitter {
  constructor(store) {
    super();
    this.store = store;
    this.sessions = new Map();
    this.active = null;
  }

  async load() {
    const records = await this.store.list();
    for (const record of records) {
      // A picture still marked "running" was cut off when the page closed.
      if (record.status === 'running') {
        record.status = 'paused';
        record.log.push({ t: Date.now(), level: 'info', message: `The page was closed at ${plural(record.shapes.length, 'shape')}. Press Resume to continue.` });
        this.store.put(record).catch(() => {});
      }
      this.sessions.set(record.id, this.wire(new Session(record, this.store)));
    }
  }

  wire(session) {
    session.on('status', () => this.emit('change'));
    session.on('saved', () => this.emit('change'));
    return session;
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => b.record.updatedAt - a.record.updatedAt);
  }

  get(id) { return this.sessions.get(id) || null; }

  /**
   * Create a picture from a prepared image and begin building it.
   * @param {{blob: Blob, width: number, height: number, originalBytes: number, storedBytes: number}} prepared
   */
  async create({ name, prepared, settings, prepLog }) {
    const s = normalizeSettings(settings);
    const side = DETAIL[s.detail].side;
    const k = Math.min(1, side / Math.max(prepared.width, prepared.height));
    const width = Math.max(1, Math.round(prepared.width * k));
    const height = Math.max(1, Math.round(prepared.height * k));
    const now = Date.now();
    const record = {
      id: randomId(),
      name,
      createdAt: now,
      updatedAt: now,
      status: 'paused',
      error: null,
      settings: s,
      width,
      height,
      background: [255, 255, 255],
      shapes: [],
      score: 1,
      elapsedMs: 0,
      originalBytes: prepared.originalBytes,
      storedBytes: prepared.storedBytes,
      thumb: null,
      log: prepLog.slice(),
    };
    // Fill in the real background and size from the pixels the search will use.
    const pixels = await analysisPixels(prepared.blob, side);
    record.width = pixels.width;
    record.height = pixels.height;
    record.background = pixels.background;
    await this.store.putSource(record.id, prepared.blob);
    await this.store.put(record);
    const session = this.wire(new Session(record, this.store));
    this.sessions.set(record.id, session);
    this.emit('change');
    return session;
  }

  /** Start (or resume) a session, pausing whichever picture was building. */
  async run(session, action = 'resume') {
    if (this.active && this.active !== session) {
      const other = this.active;
      other.pause();
      other.log('info', 'Paused because another picture started.');
    }
    this.active = session;
    this.emit('change');
    if (action === 'resume') await session.resume();
    this.emit('change');
  }

  async remove(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.pause();
      session.terminate();
      this.sessions.delete(id);
      if (this.active === session) this.active = null;
    }
    await this.store.remove(id);
    this.emit('change');
  }
}
