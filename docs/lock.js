// Password gate backed by the real backend now (see backend/server.js).
// Unlike the old GitHub Pages-only version, this is genuine server-side
// auth: the backend verifies the password itself and requires it as a
// Bearer token on every API call, so the underlying data is actually
// protected too - not just the dashboard UI.
(async function () {
  const TOKEN_KEY = "proxy-monitor-token";
  const lock = document.getElementById("lock");
  const app = document.getElementById("app");
  const form = document.getElementById("lock-form");
  const input = document.getElementById("lock-pass");
  const err = document.getElementById("lock-error");

  function unlock() {
    lock.classList.add("hidden");
    app.hidden = false;
    if (window.startDashboard) window.startDashboard();
  }

  const cached = sessionStorage.getItem(TOKEN_KEY);
  if (cached) {
    // Verify the cached password still works (backend password may have changed).
    try {
      const r = await fetch(API_BASE + "/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: cached }),
      });
      const j = await r.json();
      if (j.ok) { unlock(); return; }
      sessionStorage.removeItem(TOKEN_KEY);
    } catch { /* fall through to the login form */ }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    try {
      const r = await fetch(API_BASE + "/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: input.value }),
      });
      const j = await r.json();
      if (j.ok) {
        sessionStorage.setItem(TOKEN_KEY, input.value);
        unlock();
      } else {
        err.textContent = "Incorrect password.";
        input.value = "";
        input.focus();
      }
    } catch (e2) {
      err.textContent = "Couldn't reach the backend — check API_BASE in app.js and that the server is running.";
    }
  });
})();
