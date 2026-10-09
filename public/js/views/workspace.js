// Workspace: one picture. Live preview, progress, downloads and an activity log.

import { h, setChildren, icon } from '../ui/dom.js';
import { LIMITS, EXPORT_SIZES, DEFAULT_EXPORT_SIZE, PREVIEW_SIDE, QUALITY, SHAPE_MODES } from '../config.js';
import { renderToCanvas, fitSize } from '../render.js';
import { FORMATS, buildExport, downloadBlob } from '../exporters.js';
import { formatDuration, formatTime, matchPercent, plural, formatBytes } from '../format.js';

const STATUS_TEXT = {
  running: 'Building',
  paused: 'Paused',
  done: 'Finished',
  error: 'Stopped by an error',
};

export function workspaceView(root, session, manager, navigate) {
  const record = session.record;
  const disposers = [];
  let drawn = 0;
  let originalUrl = null;
  let showing = 'result';
  const busyExport = { id: null, progress: 0 };
  let exportSide = DEFAULT_EXPORT_SIZE;
  let exportError = '';

  // -------------------------------------------------------------- preview

  const size = fitSize({ width: record.width, height: record.height }, PREVIEW_SIDE);
  const canvas = h('canvas', {
    width: size.width, height: size.height, role: 'img', 'aria-label': 'The picture so far, built from shapes',
    style: `aspect-ratio:${record.width}/${record.height}`,
  });
  const originalImg = h('img', { alt: 'The original photo', hidden: true, style: `aspect-ratio:${record.width}/${record.height}` });
  const stage = h('div', { class: 'stage' }, canvas, originalImg);

  function paint(full = false) {
    if (full) drawn = 0;
    drawn = renderToCanvas(canvas, session.picture(), { from: drawn, count: record.shapes.length });
  }

  async function ensureOriginal() {
    if (originalUrl) return;
    const blob = await manager.store.getSource(record.id);
    if (blob) {
      originalUrl = URL.createObjectURL(blob);
      originalImg.src = originalUrl;
    }
  }

  const toggle = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Preview' });
  function renderToggle() {
    setChildren(toggle, [['result', 'Result'], ['original', 'Original']].map(([id, label]) => h('button', {
      type: 'button', 'aria-pressed': showing === id, onclick: async () => {
        showing = id;
        if (id === 'original') await ensureOriginal();
        canvas.hidden = id !== 'result';
        originalImg.hidden = id !== 'original';
        renderToggle();
      },
    }, label)));
  }

  // ------------------------------------------------------------- progress

  const percentEl = h('span', { class: 'percent' });
  const stateEl = h('span', { class: 'pill' });
  const bar = h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Build progress', 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { class: 'progress-fill' }));
  const countEl = h('p', { class: 'muted progress-count' });
  const stats = h('dl', { class: 'stats' });
  const controls = h('div', { class: 'controls' });
  const messageEl = h('p', { class: 'notice error', role: 'alert', hidden: true });
  const extendInput = h('input', { type: 'number', min: 1, step: 1, value: LIMITS.addMoreDefault, id: 'extend-count' });

  function stat(label, value) {
    return h('div', null, h('dt', null, label), h('dd', null, value));
  }

  function renderProgress() {
    const p = session.progress();
    const pct = Math.floor(p.fraction * 100);
    const status = record.status;
    percentEl.textContent = `${pct}%`;
    bar.setAttribute('aria-valuenow', pct);
    bar.setAttribute('aria-valuetext', `${pct}%, ${p.placed} of ${p.target} shapes`);
    bar.firstChild.style.width = `${p.fraction * 100}%`;
    bar.dataset.status = status;
    const starting = status === 'running' && p.placed === 0;
    stateEl.textContent = starting ? 'Getting ready' : STATUS_TEXT[status] || status;
    stateEl.className = `pill ${status}`;
    countEl.textContent = `${p.placed.toLocaleString()} of ${p.target.toLocaleString()} shapes`;
    setChildren(stats,
      stat('Match', p.placed ? `${p.match.toFixed(1)}%` : '—'),
      stat('Elapsed', formatDuration(p.elapsedMs)),
      stat(status === 'running' ? 'Time left' : 'Shape type', status === 'running' ? (p.etaMs ? `about ${formatDuration(p.etaMs)}` : 'estimating…') : (SHAPE_MODES.find((m) => m.value === record.settings.mode)?.label || '')),
      stat('Effort', QUALITY[record.settings.quality]?.label || ''));

    messageEl.hidden = status !== 'error';
    messageEl.textContent = record.error || '';

    const atLimit = p.placed >= LIMITS.maxShapes;
    const room = LIMITS.maxShapes - p.placed;
    extendInput.max = Math.max(1, room);
    const buttons = [];
    if (status === 'running') {
      buttons.push(h('button', { type: 'button', class: 'btn', onclick: () => session.pause() }, icon('pause'), 'Pause'));
    } else if (status === 'paused' || status === 'error') {
      buttons.push(h('button', { type: 'button', class: 'btn primary', onclick: () => manager.run(session) }, icon('play'), status === 'error' ? 'Try again' : 'Resume'));
    }
    setChildren(controls, buttons,
      status === 'done' ? (atLimit
        ? h('p', { class: 'help' }, `This picture has reached the ${LIMITS.maxShapes.toLocaleString()}-shape limit. Start a new picture for more detail.`)
        : h('form', { class: 'extend', novalidate: true, onsubmit: onExtend },
          h('label', { for: 'extend-count' }, 'Add more shapes'),
          h('div', { class: 'extend-row' }, extendInput,
            h('button', { type: 'submit', class: 'btn primary' }, icon('plus'), 'Add'),
          ),
          h('p', { class: 'help' }, `Up to ${room.toLocaleString()} more.`))) : null);
    document.title = status === 'running' ? `${pct}% · Primitive Pictures` : `${record.name} · Primitive Pictures`;
  }

  async function onExtend(e) {
    e.preventDefault();
    const room = LIMITS.maxShapes - record.shapes.length;
    const want = Math.round(Number(extendInput.value));
    if (!Number.isFinite(want) || want < 1) return;
    const extra = Math.min(room, want);
    if (want > room) session.log('warn', `Only ${room.toLocaleString()} more shapes fit under the ${LIMITS.maxShapes.toLocaleString()} limit, so that many were added.`);
    await manager.run(session, 'none');
    session.addShapes(extra);
  }

  // ------------------------------------------------------------ downloads

  const downloadList = h('div', { class: 'downloads' });
  function renderDownloads() {
    const empty = record.shapes.length === 0;
    const sizeSelect = h('label', { class: 'field inline' }, h('span', null, 'PNG and JPG size'),
      h('select', { onchange: (e) => { exportSide = Number(e.target.value); } },
        EXPORT_SIZES.map((s) => h('option', { value: s, selected: s === exportSide }, `${s.toLocaleString()} px`))));
    setChildren(downloadList,
      sizeSelect,
      h('ul', { class: 'format-list' }, FORMATS.map((f) => {
        const busy = busyExport.id === f.id;
        return h('li', null,
          h('div', null, h('strong', null, f.label), h('span', { class: 'muted' }, f.hint)),
          h('button', {
            type: 'button', class: 'btn small', disabled: empty || busyExport.id !== null, onclick: () => download(f.id),
            'aria-label': `Download ${f.label}`,
          }, busy ? (f.id === 'gif' ? `Making… ${Math.round(busyExport.progress * 100)}%` : 'Preparing…') : [icon('download', 16), 'Download']));
      })),
      exportError ? h('p', { class: 'error', role: 'alert' }, exportError) : null,
      record.status === 'running' ? h('p', { class: 'help' }, 'Downloads use the shapes placed so far.') : null,
      h('p', { class: 'help' }, 'SVG is a vector file and stays sharp at any size.'));
  }

  async function download(id) {
    exportError = '';
    busyExport.id = id;
    busyExport.progress = 0;
    renderDownloads();
    try {
      // Snapshot so shapes added while encoding don't change the file.
      const snapshot = { ...record, shapes: record.shapes.slice() };
      const { blob, filename } = await buildExport(id, snapshot, {
        side: exportSide,
        onProgress: (n) => { busyExport.progress = n; renderDownloads(); },
      });
      downloadBlob(blob, filename);
      session.log('ok', `Downloaded ${filename} (${formatBytes(blob.size)})`);
    } catch (err) {
      exportError = err.message;
      session.log('error', `Download failed: ${err.message}`);
    }
    busyExport.id = null;
    renderDownloads();
  }

  // ------------------------------------------------------------------ log

  const logEl = h('ol', { class: 'log', tabindex: 0, 'aria-label': 'Activity log' });
  function logLine(line) {
    return h('li', { class: `lv-${line.level}` }, h('time', null, formatTime(line.t)), h('span', null, line.message));
  }
  function renderLog() {
    setChildren(logEl, record.log.map(logLine));
    logEl.scrollTop = logEl.scrollHeight;
  }
  function appendLog(line) {
    const stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24;
    logEl.append(logLine(line));
    while (logEl.children.length > 250) logEl.firstChild.remove();
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------------------------------------------------------------- events

  let lastPaint = 0;
  disposers.push(session.on('progress', () => {
    const now = performance.now();
    if (showing === 'result' && now - lastPaint > 60) {
      paint();
      lastPaint = now;
    }
    renderProgress();
    if (record.shapes.length === 1 || record.shapes.length % 10 === 0) renderDownloads();
  }));
  disposers.push(session.on('status', () => {
    paint();
    renderProgress();
    renderDownloads();
  }));
  disposers.push(session.on('log', appendLog));
  const tickTimer = setInterval(() => { if (record.status === 'running') renderProgress(); }, 500);
  disposers.push(() => clearInterval(tickTimer));

  async function remove() {
    if (!confirm(`Delete "${record.name}"? This removes it from this browser.`)) return;
    await manager.remove(record.id);
    navigate('#/');
  }

  // ---------------------------------------------------------------- layout

  setChildren(root,
    h('div', { class: 'workspace' },
      h('div', { class: 'ws-head' },
        h('a', { class: 'btn ghost small', href: '#/' }, icon('back', 16), 'All pictures'),
        h('h1', { class: 'truncate' }, record.name),
        stateEl,
        h('button', { type: 'button', class: 'btn ghost small danger', onclick: remove }, icon('trash', 16), 'Delete')),
      h('div', { class: 'ws-grid' },
        h('section', { class: 'ws-preview card', 'aria-label': 'Preview' },
          h('div', { class: 'preview-head' }, toggle,
            h('span', { class: 'muted' }, `${record.width} × ${record.height} px working size`)),
          stage),
        h('div', { class: 'ws-side' },
          h('section', { class: 'card', 'aria-labelledby': 'progress-title' },
            h('div', { class: 'progress-head' }, h('h2', { id: 'progress-title' }, 'Progress'), percentEl),
            bar, countEl, stats, messageEl, controls),
          h('section', { class: 'card', 'aria-labelledby': 'download-title' },
            h('h2', { id: 'download-title' }, 'Download'), downloadList)),
        h('section', { class: 'card ws-log', 'aria-labelledby': 'log-title' },
          h('h2', { id: 'log-title' }, 'Activity'), logEl))));

  renderToggle();
  paint(true);
  renderProgress();
  renderDownloads();
  renderLog();

  return {
    destroy() {
      disposers.forEach((fn) => fn());
      if (originalUrl) URL.revokeObjectURL(originalUrl);
    },
  };
}
