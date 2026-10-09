// Entry point: opens the store, loads saved pictures, and switches between the
// home view and a picture's workspace using the URL hash (#/ and #/p/<id>).

import { openStore } from './store.js';
import { Manager } from './runner.js';
import { homeView } from './views/home.js';
import { workspaceView } from './views/workspace.js';

const app = document.getElementById('app');
let manager = null;
let current = null;

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route() {
  current?.destroy?.();
  current = null;
  document.title = 'Primitive Pictures';
  const match = location.hash.match(/^#\/p\/(.+)$/);
  if (match) {
    const session = manager.get(decodeURIComponent(match[1]));
    if (session) current = workspaceView(app, session, manager, navigate);
    else navigate('#/');
  } else {
    current = homeView(app, manager, navigate);
  }
  window.scrollTo(0, 0);
}

async function main() {
  if (!window.Worker || !window.createImageBitmap) {
    app.textContent = 'This browser is too old to run Primitive Pictures. Try a recent Chrome, Edge, Firefox or Safari.';
    return;
  }
  const store = await openStore();
  manager = new Manager(store);
  manager.persistent = store.persistent;
  await manager.load();
  window.addEventListener('hashchange', route);
  route();
}

main().catch((err) => {
  console.error(err);
  app.textContent = `Something went wrong while starting: ${err.message}`;
});
