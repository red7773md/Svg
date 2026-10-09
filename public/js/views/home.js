// Home: choose a photo, choose how many shapes, start. Below it, the history
// of pictures saved in this browser.

import { h, setChildren, icon } from '../ui/dom.js';
import {
  LIMITS, SHAPE_MODES, QUALITY, DETAIL, OPACITY,
  DEFAULT_QUALITY, DEFAULT_DETAIL, DEFAULT_OPACITY,
} from '../config.js';
import { prepareImage } from '../imageprep.js';
import { normalizeSettings, clampShapes } from '../runner.js';
import { formatBytes, matchPercent, timeAgo, plural } from '../format.js';

const SETTINGS_KEY = 'primitive-pictures:settings';

function loadSettings() {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {});
  } catch {
    return normalizeSettings({});
  }
}

function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* optional */ }
}

const STATUS_LABEL = { running: 'Building', paused: 'Paused', done: 'Finished', error: 'Stopped' };

export function homeView(root, manager, navigate) {
  const settings = loadSettings();
  const state = { prepared: null, name: '', log: [], busy: false, error: '', previewUrl: null };
  const disposers = [];

  // ---------------------------------------------------------------- photo

  const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'visually-hidden', id: 'photo-input' });
  const dropZone = h('label', { class: 'drop', for: 'photo-input' });
  const photoSlot = h('div', { class: 'photo-slot' });

  function renderPhoto() {
    if (state.busy) {
      setChildren(photoSlot, h('div', { class: 'drop drop-busy', role: 'status' }, h('span', { class: 'spinner' }), 'Preparing your photo…'), logList());
      return;
    }
    if (state.prepared) {
      setChildren(photoSlot,
        h('div', { class: 'staged' },
          h('img', { src: state.previewUrl, alt: `Preview of ${state.name}` }),
          h('div', { class: 'staged-info' },
            h('strong', { class: 'truncate' }, state.name),
            h('span', { class: 'muted' }, `${state.prepared.width} × ${state.prepared.height} px · ${formatBytes(state.prepared.storedBytes)}`),
            h('label', { class: 'btn small', for: 'photo-input' }, 'Choose another photo'),
          ),
        ),
        logList());
      return;
    }
    setChildren(dropZone,
      icon('upload', 28),
      h('strong', null, 'Drop a photo here'),
      h('span', { class: 'muted' }, 'or click to choose one. You can also paste from the clipboard.'),
      h('span', { class: 'muted small-text' }, 'PNG, JPEG, WebP, GIF or BMP. Large photos are shrunk automatically.'),
    );
    setChildren(photoSlot, dropZone, state.log.length ? logList() : null);
  }

  function logList() {
    if (!state.log.length) return null;
    return h('ul', { class: 'prep-log', 'aria-label': 'Photo preparation log' },
      state.log.map((line) => h('li', { class: `lv-${line.level}` }, line.message)));
  }

  async function handleFile(file) {
    if (!file || state.busy) return;
    state.busy = true;
    state.error = '';
    state.log = [];
    state.prepared = null;
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
    renderPhoto();
    renderStart();
    try {
      const prepared = await prepareImage(file, (level, message) => {
        state.log.push({ level, message });
        renderPhoto();
      });
      state.prepared = prepared;
      state.name = file.name || 'pasted-image.png';
      state.previewUrl = URL.createObjectURL(prepared.blob);
    } catch (err) {
      state.error = err.message;
      state.log.push({ level: 'error', message: err.message });
    }
    state.busy = false;
    renderPhoto();
    renderStart();
  }

  fileInput.addEventListener('change', () => {
    handleFile(fileInput.files[0]);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((type) => root.addEventListener(type, (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    photoSlot.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach((type) => root.addEventListener(type, (e) => {
    if (type === 'dragleave' && root.contains(e.relatedTarget)) return;
    photoSlot.classList.remove('dragging');
  }));
  root.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    handleFile(e.dataTransfer.files[0]);
  });
  const onPaste = (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) handleFile(file);
  };
  document.addEventListener('paste', onPaste);
  disposers.push(() => document.removeEventListener('paste', onPaste));

  // --------------------------------------------------------------- shapes

  const shapesInput = h('input', {
    type: 'number', id: 'shape-count', inputmode: 'numeric', min: LIMITS.minShapes, max: LIMITS.maxShapes, step: 10,
    value: settings.shapes, 'aria-describedby': 'shape-help',
  });
  const shapesRange = h('input', {
    type: 'range', min: LIMITS.minShapes, max: LIMITS.maxShapes, step: 10, value: settings.shapes, 'aria-label': 'Number of shapes',
  });
  const shapeHelp = h('p', { id: 'shape-help', class: 'help', role: 'status' });
  const presetRow = h('div', { class: 'presets', role: 'group', 'aria-label': 'Common shape counts' });

  function helpText(extra = '') {
    shapeHelp.textContent = extra
      || `More shapes mean more detail and a longer wait. Between ${LIMITS.minShapes} and ${LIMITS.maxShapes.toLocaleString()}.`;
    shapeHelp.classList.toggle('warn', Boolean(extra));
  }

  function setShapes(value, { note = '' } = {}) {
    settings.shapes = clampShapes(value);
    shapesInput.value = settings.shapes;
    shapesRange.value = settings.shapes;
    helpText(note);
    renderPresets();
  }

  function renderPresets() {
    setChildren(presetRow, LIMITS.presets.map((n) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': settings.shapes === n, onclick: () => setShapes(n),
    }, n.toLocaleString())));
  }

  shapesInput.addEventListener('input', () => {
    const v = Number(shapesInput.value);
    if (Number.isFinite(v) && v >= LIMITS.minShapes && v <= LIMITS.maxShapes) {
      settings.shapes = Math.round(v);
      shapesRange.value = settings.shapes;
      helpText();
      renderPresets();
    }
  });
  shapesInput.addEventListener('change', () => {
    const raw = Number(shapesInput.value);
    let note = '';
    if (raw > LIMITS.maxShapes) note = `The most you can ask for is ${LIMITS.maxShapes.toLocaleString()}, so it was set to that.`;
    else if (raw < LIMITS.minShapes) note = `At least ${LIMITS.minShapes} shapes are needed, so it was set to that.`;
    setShapes(raw, { note });
  });
  shapesRange.addEventListener('input', () => setShapes(shapesRange.value));
  renderPresets();
  helpText();

  // ----------------------------------------------------------- shape type

  const modeGroup = h('div', { class: 'modes', role: 'radiogroup', 'aria-label': 'Shape type' });
  const modeHint = h('p', { class: 'help' });
  function renderModes() {
    setChildren(modeGroup, SHAPE_MODES.map((m) => h('label', { class: 'mode' },
      h('input', {
        type: 'radio', name: 'mode', value: m.value, checked: settings.mode === m.value,
        onchange: () => { settings.mode = m.value; renderModes(); },
      }),
      h('span', null, m.label))));
    modeHint.textContent = SHAPE_MODES.find((m) => m.value === settings.mode)?.hint || '';
  }
  renderModes();

  function select(label, options, current, onChange) {
    const el = h('select', { onchange: (e) => onChange(e.target.value) },
      options.map(([value, text]) => h('option', { value, selected: String(value) === String(current) }, text)));
    return h('label', { class: 'field' }, h('span', null, label), el);
  }

  const advanced = h('details', { class: 'advanced' },
    h('summary', null, 'Advanced settings'),
    h('div', { class: 'advanced-grid' },
      select('Search effort', Object.entries(QUALITY).map(([k, v]) => [k, v.label]), settings.quality || DEFAULT_QUALITY, (v) => { settings.quality = v; }),
      select('Working detail', Object.entries(DETAIL).map(([k, v]) => [k, v.label]), settings.detail || DEFAULT_DETAIL, (v) => { settings.detail = v; }),
      select('Shape opacity', OPACITY.map((o) => [o.value, o.label]), settings.opacity ?? DEFAULT_OPACITY, (v) => { settings.opacity = Number(v); }),
    ),
    h('p', { class: 'help' }, 'Search effort and detail change how long each shape takes. The defaults suit most photos.'),
  );

  // ---------------------------------------------------------------- start

  const startSlot = h('div', { class: 'start' });
  function renderStart() {
    const ready = Boolean(state.prepared) && !state.busy;
    setChildren(startSlot,
      h('button', { type: 'button', class: 'btn primary large', disabled: !ready, onclick: start },
        icon('play', 18), `Build with ${settings.shapes.toLocaleString()} shapes`),
      !ready && !state.busy ? h('p', { class: 'help' }, 'Choose a photo to begin.') : null,
      state.error ? h('p', { class: 'error', role: 'alert' }, state.error) : null,
    );
  }
  shapesInput.addEventListener('input', renderStart);
  shapesInput.addEventListener('change', renderStart);
  shapesRange.addEventListener('input', renderStart);
  presetRow.addEventListener('click', renderStart);

  async function start() {
    if (!state.prepared) return;
    const chosen = normalizeSettings(settings);
    saveSettings(chosen);
    const button = startSlot.querySelector('button');
    if (button) button.disabled = true;
    try {
      const session = await manager.create({
        name: state.name,
        prepared: state.prepared,
        settings: chosen,
        prepLog: state.log.map((l) => ({ t: Date.now(), level: l.level, message: l.message })),
      });
      manager.run(session);
      navigate(`#/p/${encodeURIComponent(session.id)}`);
    } catch (err) {
      state.error = `Could not start: ${err.message}`;
      renderStart();
    }
  }

  // -------------------------------------------------------------- history

  let historyUrls = [];
  const historySlot = h('section', { class: 'history', 'aria-labelledby': 'history-title' });
  function renderHistory() {
    const sessions = manager.list();
    historyUrls.forEach((u) => URL.revokeObjectURL(u));
    const urls = [];
    historyUrls = urls;
    const cards = sessions.map((s) => {
      const r = s.record;
      let thumb;
      if (r.thumb) {
        const url = URL.createObjectURL(r.thumb);
        urls.push(url);
        thumb = h('img', { src: url, alt: '', loading: 'lazy' });
      } else {
        thumb = h('div', { class: 'thumb-empty' }, icon('image', 28));
      }
      const placed = r.shapes.length;
      return h('li', null,
        h('a', { class: 'card history-card', href: `#/p/${encodeURIComponent(r.id)}` },
          h('div', { class: 'thumb' }, thumb),
          h('div', { class: 'history-body' },
            h('div', { class: 'history-top' },
              h('strong', { class: 'truncate' }, r.name),
              h('span', { class: `pill ${r.status}` }, STATUS_LABEL[r.status] || r.status)),
            h('span', { class: 'muted' }, `${placed.toLocaleString()} of ${r.settings.shapes.toLocaleString()} shapes${placed ? ` · ${matchPercent(r.score).toFixed(0)}% match` : ''}`),
            h('div', { class: 'mini-bar', 'aria-hidden': 'true' }, h('span', { style: `width:${Math.min(100, (placed / r.settings.shapes) * 100)}%` })),
            h('span', { class: 'muted small-text' }, timeAgo(r.updatedAt)))));
    });
    setChildren(historySlot,
      h('div', { class: 'section-head' },
        h('h2', { id: 'history-title' }, 'Your pictures'),
        sessions.length ? h('span', { class: 'muted' }, plural(sessions.length, 'picture')) : null),
      sessions.length
        ? h('ul', { class: 'history-grid' }, cards)
        : h('p', { class: 'empty' }, 'Pictures you make are saved in this browser and appear here, so you can come back to them or finish one later.'),
      manager.persistent ? null : h('p', { class: 'notice' }, 'This browser is not allowing saved data (private window?), so history will be lost when you close the page.'));
  }
  const offChange = manager.on('change', renderHistory);
  disposers.push(offChange, () => historyUrls.forEach((u) => URL.revokeObjectURL(u)));

  // ---------------------------------------------------------------- layout

  setChildren(root,
    h('div', { class: 'home' },
      h('section', { class: 'hero' },
        h('h1', null, 'Turn a photo into shapes'),
        h('p', { class: 'lead' }, 'Pick a photo, choose how many shapes to use, and watch the picture build itself. Download it as PNG, JPG, SVG, GIF or JSON.')),
      h('form', { class: 'card setup', novalidate: true, onsubmit: (e) => { e.preventDefault(); start(); } },
        h('div', { class: 'block' }, h('h2', null, 'Photo'), photoSlot, fileInput),
        h('div', { class: 'block' },
          h('h2', null, 'Number of shapes'),
          h('div', { class: 'count-row' },
            h('div', { class: 'count-input' }, shapesInput, h('span', { class: 'muted' }, 'shapes')),
            shapesRange),
          presetRow, shapeHelp),
        h('div', { class: 'block' }, h('h2', null, 'Shape type'), modeGroup, modeHint),
        advanced,
        startSlot),
      historySlot));
  renderPhoto();
  renderStart();
  renderHistory();

  return { destroy() { disposers.forEach((fn) => fn()); if (state.previewUrl) URL.revokeObjectURL(state.previewUrl); } };
}
