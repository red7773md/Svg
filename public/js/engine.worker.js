// Web Worker wrapper around the search engine. Each worker keeps its own copy
// of the target image and the picture so far. The coordinator (runner.js)
// asks every worker to search, keeps the best shape, and tells all workers to
// apply it, so all copies stay identical.
//
// Messages in:  init | restore | search | apply
// Messages out: ready | restored | result | error

import { Engine } from './engine/engine.js';

let engine = null;

function reply(message) {
  self.postMessage(message);
}

self.onmessage = (event) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'init': {
        engine = new Engine({
          width: msg.width,
          height: msg.height,
          target: new Uint8Array(msg.target),
          background: msg.background,
          seed: msg.seed,
        });
        reply({ type: 'ready', energy: engine.total });
        break;
      }
      case 'restore': {
        engine.restore(msg.shapes);
        reply({ type: 'restored', energy: engine.total });
        break;
      }
      case 'search': {
        const found = engine.search(msg.options);
        reply({ type: 'result', id: msg.id, shape: found.shape, energy: found.energy, evals: found.evals });
        break;
      }
      case 'apply': {
        engine.apply(msg.shape);
        break;
      }
      default:
        throw new Error(`unknown message "${msg.type}"`);
    }
  } catch (err) {
    reply({ type: 'error', id: msg.id, message: err && err.message ? err.message : String(err) });
  }
};
