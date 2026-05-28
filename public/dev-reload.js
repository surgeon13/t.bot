'use strict';

/**
 * Dev-only live reload: connects to GET /api/dev/reload (SSE) when npm run gui:dev is active.
 * In production (npm run gui) the endpoint is absent; the connection closes quietly.
 */
(function () {
  let es;

  function connect() {
    if (es) {
      try { es.close(); } catch { /* ignore */ }
    }
    es = new EventSource('/api/dev/reload');
    es.onmessage = ev => {
      if (ev.data === 'reload') {
        console.info('[t.bot dev] Reloading page…');
        location.reload();
      }
    };
    es.onerror = () => {
      es.close();
      es = null;
    };
  }

  connect();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !es) connect();
  });
})();
