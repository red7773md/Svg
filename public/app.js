(() => {
  'use strict';

  // ---------- settings ----------
  const LIMIT_BYTES = 4 * 1024 * 1024;   // the server accepts up to 4 MB per request
  const MAX_RUNS = 12;                    // hard stop for one picture
  const MIN_GAIN = 0.005;                 // stop when a run improves the score by under 0.5%
  const MAX_TOTAL_SHAPES = 3000;          // matches the server limit
  const MAX_LOG_LINES = 300;
  const DB_NAME = 'primitive-web';
  const STORE = 'jobs';
  const LABELS = { preparing: 'Preparing', running: 'Running', paused: 'Paused', done: 'Done', error: 'Error' };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    form: $('newJob'), file: $('file'), fileHint: $('fileHint'),
    n: $('n'), nOut: $('nOut'), mode: $('mode'), size: $('size'), start: $('start'),
    empty: $('jobEmpty'), view: $('jobView'), name: $('jobName'), meta: $('jobMeta'),
    status: $('jobStatus'), bar: $('bar'), barFill: $('barFill'), statusLine: $('statusLine'),
    mainImg: $('mainImg'), pause: $('pause'), resume: $('resume'), download: $('download'),
    remove: $('remove'), timeline: $('timeline'), log: $('log'), history: $('history'),
  };

  // ---------- state ----------
  let jobs = [];
  let activeId = null;
  let runningId = null;
  let pauseRequested = false;
  let selectedRun = null;        // index into the active job's runs, or null for the latest
  let timer = null;
  const urls = new WeakMap();    // Blob -> object URL

  // ---------- storage (IndexedDB, kept in this browser) ----------
  const dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function saveJob(job) {
    job.updatedAt = Date.now();
    const db = await dbPromise;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(job);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadJobs() {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function removeJob(id) {
    const db = await dbPromise;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---------- helpers ----------
  const mb = (bytes) => (bytes / 1048576).toFixed(2) + ' MB';
  const activeJob = () => jobs.find((j) => j.id === activeId) || null;

  function urlFor(blob) {
    if (!urls.has(blob)) urls.set(blob, URL.createObjectURL(blob));
    return urls.get(blob);
  }

  function pngBlob(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'image/png' });
  }

  function timeAgo(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function log(job, msg, level = '') {
    job.logs.push({ t: new Date().toISOString(), msg, level });
    if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
    if (job.id === activeId) renderLog(job);
  }

  // ---------- image preparation: shrink and strip metadata ----------
  function drawJpeg(bitmap, w, h, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';            // transparent areas become white
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('the browser could not encode this image'))),
        'image/jpeg',
        quality,
      );
    });
  }

  async function prepareImage(file, job) {
    if (!file.type.startsWith('image/')) throw new Error('that file is not an image');
    log(job, `Selected ${file.name} (${mb(file.size)}).`);
    if (file.size > LIMIT_BYTES) {
      log(job, `This image is larger than the ${mb(LIMIT_BYTES)} upload limit. Reducing its size to make it compatible…`, 'warn');
    } else {
      log(job, 'Removing metadata and re-encoding the image for upload…');
    }

    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    // Analysis runs at 256 px on the server, so these sizes lose no detail that matters.
    const attempts = [[1024, 0.92], [1024, 0.8], [768, 0.8], [512, 0.75]];
    let blob = null;
    for (const [maxSide, quality] of attempts) {
      const scale = Math.min(1, maxSide / longest);
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      blob = await drawJpeg(bitmap, w, h, quality);
      log(job, `Encoded at ${w}×${h}, quality ${quality}: ${mb(blob.size)}.`);
      if (blob.size <= LIMIT_BYTES) break;
      log(job, 'Still over the limit, reducing further…', 'warn');
    }
    if (bitmap.close) bitmap.close();
    if (blob.size > LIMIT_BYTES) throw new Error('the image is still too large after reducing it');
    log(job, `Ready to upload: ${mb(blob.size)}, metadata removed.`);
    return blob;
  }

  // ---------- server calls ----------
  async function callRun(job) {
    const fd = new FormData();
    fd.append('image', job.image, 'upload.jpg');
    fd.append('n', String(job.settings.n));
    fd.append('mode', String(job.settings.mode));
    fd.append('size', String(job.settings.size));
    if (job.state) fd.append('state', JSON.stringify(job.state));

    const res = await fetch('/api/primitive', { method: 'POST', body: fd });
    if (!res.ok) {
      const type = res.headers.get('content-type') || '';
      const text = type.includes('text/plain') ? (await res.text()).trim() : '';
      throw new Error(text || `the server returned ${res.status}`);
    }
    return res.json();
  }

  // ---------- run loop ----------
  function finishReason(job, prevScore, score) {
    if (prevScore !== null && prevScore > 0 && (prevScore - score) / prevScore < MIN_GAIN) {
      return `Final version reached: the last run improved the score by less than ${MIN_GAIN * 100}%.`;
    }
    if (job.runs.length >= MAX_RUNS) return `Stopped after ${MAX_RUNS} runs (run limit).`;
    if (job.state && job.state.shapes.length >= MAX_TOTAL_SHAPES) return 'Stopped: shape limit reached for this image.';
    return null;
  }

  function startTimer(job, runNo) {
    const t0 = Date.now();
    els.bar.classList.add('busy');
    timer = setInterval(() => {
      if (job.id !== activeId) return;
      const secs = Math.round((Date.now() - t0) / 1000);
      els.statusLine.textContent = `Run ${runNo} in progress… ${secs}s elapsed (limit 50 s)`;
    }, 1000);
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
    els.bar.classList.remove('busy');
  }

  async function runJob(job) {
    if (runningId) return;
    runningId = job.id;
    pauseRequested = false;
    job.status = 'running';
    job.finishNote = null;
    await saveJob(job);
    renderAll();

    try {
      while (job.status === 'running') {
        const runNo = job.runs.length + 1;
        const prevScore = job.runs.length ? job.runs[job.runs.length - 1].score : null;
        log(job, `Run ${runNo} started (up to ${job.settings.n} shapes, 50 s limit).`);
        startTimer(job, runNo);
        const started = performance.now();
        const data = await callRun(job);
        stopTimer();
        const seconds = (performance.now() - started) / 1000;

        job.runs.push({
          n: runNo,
          png: pngBlob(data.image),
          score: data.score,
          placed: data.placed,
          total: data.total,
          stoppedEarly: data.stoppedEarly,
          seconds,
          at: Date.now(),
        });
        job.state = data.state;
        job.width = data.width;
        job.height = data.height;

        let summary = `Run ${runNo} finished: ${data.placed} shapes added (${data.total} total), score ${data.score.toFixed(4)}`;
        if (prevScore !== null) {
          const gain = ((prevScore - data.score) / prevScore) * 100;
          summary += gain >= 0 ? `, improved ${gain.toFixed(2)}%` : ', no improvement';
        }
        log(job, summary + '.');
        if (data.stoppedEarly) log(job, `Stopped at the time limit after ${data.placed} of ${data.requested} shapes.`, 'warn');

        const reason = finishReason(job, prevScore, data.score);
        if (reason) {
          job.status = 'done';
          job.finishNote = reason;
          log(job, reason);
        } else if (pauseRequested) {
          job.status = 'paused';
          log(job, 'Paused. Press Continue to add more runs.');
        }
        await saveJob(job);
        renderAll();
      }
    } catch (err) {
      stopTimer();
      job.status = 'paused';
      log(job, `Run failed: ${err.message}. Your progress is saved; press Continue to retry.`, 'err');
      await saveJob(job).catch(() => {});
    } finally {
      stopTimer();
      runningId = null;
      pauseRequested = false;
      renderAll();
    }
  }

  async function startNewJob(file) {
    const job = {
      id: crypto.randomUUID(),
      name: file.name,
      status: 'preparing',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settings: { n: Number(els.n.value), mode: Number(els.mode.value), size: Number(els.size.value) },
      image: null,
      width: 0,
      height: 0,
      runs: [],
      state: null,
      finishNote: null,
      logs: [],
    };
    jobs.unshift(job);
    activeId = job.id;
    selectedRun = null;
    renderAll();

    try {
      job.image = await prepareImage(file, job);
    } catch (err) {
      job.status = 'error';
      log(job, `Could not prepare the image: ${err.message}.`, 'err');
      await saveJob(job);
      renderAll();
      return;
    }
    await saveJob(job);
    runJob(job);   // not awaited: the run keeps going while the page stays open
  }

  function continueJob(job) {
    if (runningId || !job.image || job.status === 'done') return;
    runJob(job);
  }

  async function deleteJob(job) {
    if (runningId === job.id) {
      alert('Pause this picture before deleting it.');
      return;
    }
    if (!confirm(`Delete "${job.name}" and all of its runs?`)) return;
    await removeJob(job.id);
    jobs = jobs.filter((j) => j.id !== job.id);
    if (activeId === job.id) activeId = jobs.length ? jobs[0].id : null;
    selectedRun = null;
    renderAll();
  }

  // ---------- rendering ----------
  function renderHistory() {
    els.history.replaceChildren(...jobs.map((job) => {
      const li = document.createElement('li');
      li.className = 'history-item' + (job.id === activeId ? ' selected' : '');

      const last = job.runs[job.runs.length - 1];
      let thumb;
      if (last || job.image) {
        thumb = document.createElement('img');
        thumb.src = urlFor(last ? last.png : job.image);
        thumb.alt = '';
      } else {
        thumb = document.createElement('div');
        thumb.className = 'history-thumb';
      }

      const text = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = job.name;
      const span = document.createElement('span');
      const count = job.runs.length;
      span.textContent = `${LABELS[job.status] || job.status} · ${count} run${count === 1 ? '' : 's'} · ${timeAgo(job.updatedAt)}`;
      text.append(strong, span);

      li.append(thumb, text);
      li.addEventListener('click', () => {
        activeId = job.id;
        selectedRun = null;
        renderAll();
      });
      return li;
    }));
  }

  function renderLog(job) {
    els.log.replaceChildren(...job.logs.map((entry) => {
      const li = document.createElement('li');
      if (entry.level) li.className = entry.level;
      const time = document.createElement('time');
      time.textContent = new Date(entry.t).toLocaleTimeString();
      li.append(time, document.createTextNode(entry.msg));
      return li;
    }));
    els.log.scrollTop = els.log.scrollHeight;
  }

  function renderJob() {
    const job = activeJob();
    els.empty.hidden = !!job;
    els.view.hidden = !job;
    if (!job) return;

    const isRunning = runningId === job.id;
    const shapes = job.state ? job.state.shapes.length : 0;
    els.name.textContent = job.name;
    const size = job.width && job.height ? `${job.width}×${job.height} · ` : '';
    els.meta.textContent = `${size}${job.runs.length} run${job.runs.length === 1 ? '' : 's'} · ${shapes} shapes`;
    els.status.textContent = LABELS[job.status] || job.status;
    els.status.className = 'pill ' + job.status;

    // progress bar: indeterminate while a run is in flight, otherwise runs so far out of the limit
    els.bar.classList.toggle('busy', isRunning);
    els.barFill.style.width = job.status === 'done' ? '100%' : `${Math.min(100, (job.runs.length / MAX_RUNS) * 100)}%`;

    if (!isRunning) {
      if (job.status === 'done') els.statusLine.textContent = job.finishNote || 'Done.';
      else if (job.status === 'paused') els.statusLine.textContent = job.runs.length
        ? `Paused after ${job.runs.length} run${job.runs.length === 1 ? '' : 's'}. Press Continue to add more.`
        : 'Paused before the first run.';
      else if (job.status === 'preparing') els.statusLine.textContent = 'Preparing the image…';
      else if (job.status === 'error') els.statusLine.textContent = 'This picture could not be started.';
    }

    const shown = selectedRun !== null && selectedRun < job.runs.length ? selectedRun : job.runs.length - 1;
    const run = job.runs[shown];
    const previewBlob = run ? run.png : job.image;
    if (previewBlob) {
      els.mainImg.src = urlFor(previewBlob);
      els.mainImg.hidden = false;
    } else {
      els.mainImg.removeAttribute('src');
      els.mainImg.hidden = true;
    }

    els.download.hidden = !run;
    if (run) {
      els.download.href = urlFor(run.png);
      els.download.download = `${job.name.replace(/\.[^.]+$/, '')}-run${run.n}.png`;
    }

    els.pause.hidden = !isRunning;
    els.pause.disabled = pauseRequested;
    els.resume.hidden = !(!isRunning && job.status === 'paused' && job.image);

    els.timeline.replaceChildren(...job.runs.map((r, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'run' + (i === shown ? ' selected' : '');
      const img = document.createElement('img');
      img.src = urlFor(r.png);
      img.alt = `Run ${r.n}`;
      const cap = document.createElement('small');
      cap.textContent = `Run ${r.n} · ${r.total} shapes · ${r.score.toFixed(4)}`;
      btn.append(img, cap);
      btn.addEventListener('click', () => {
        selectedRun = i;
        renderJob();
      });
      return btn;
    }));

    renderLog(job);
  }

  function renderAll() {
    renderHistory();
    renderJob();
  }

  // ---------- events ----------
  els.n.addEventListener('input', () => { els.nOut.textContent = els.n.value; });

  els.file.addEventListener('change', () => {
    const f = els.file.files[0];
    els.fileHint.textContent = f
      ? `${f.name} · ${mb(f.size)}${f.size > LIMIT_BYTES ? ' (will be reduced)' : ''}`
      : 'PNG, JPEG, or other common formats. Large files are shrunk automatically.';
  });

  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = els.file.files[0];
    if (!file) return;
    if (runningId) {
      alert('A picture is already running. Pause it first.');
      return;
    }
    els.start.disabled = true;
    try {
      await startNewJob(file);
    } finally {
      els.start.disabled = false;
      els.file.value = '';
      els.fileHint.textContent = 'PNG, JPEG, or other common formats. Large files are shrunk automatically.';
    }
  });

  els.pause.addEventListener('click', () => {
    pauseRequested = true;
    els.pause.disabled = true;
    els.statusLine.textContent = 'Pausing after this run finishes…';
  });

  els.resume.addEventListener('click', () => {
    const job = activeJob();
    if (job) continueJob(job);
  });

  els.remove.addEventListener('click', () => {
    const job = activeJob();
    if (job) deleteJob(job);
  });

  // ---------- startup ----------
  async function init() {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    jobs = await loadJobs();
    for (const job of jobs) {
      if (job.status === 'running' || job.status === 'preparing') {
        job.status = job.image ? 'paused' : 'error';
        log(job, job.image
          ? 'Interrupted: the page was closed during a run. Press Continue to resume from the last finished run.'
          : 'Interrupted while preparing the image. Delete it and start again.', 'warn');
        await saveJob(job);
      }
    }
    jobs.sort((a, b) => b.updatedAt - a.updatedAt);
    activeId = jobs.length ? jobs[0].id : null;
    renderAll();
  }

  init().catch((err) => {
    els.statusLine.textContent = `Could not load saved pictures: ${err.message}`;
    console.error(err);
  });
})();
