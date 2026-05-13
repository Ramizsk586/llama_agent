const OFFLINE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Boop Dashboard</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #020617; color: #e2e8f0; }
      main { width: min(440px, calc(100vw - 40px)); }
      h1 { margin: 0 0 8px; font-size: 24px; }
      p { margin: 0; color: #94a3b8; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>Boop is offline</h1>
      <p>The dashboard needs the local agent server and tunnel to be running. Reopen it once Boop is back online.</p>
    </main>
  </body>
</html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(OFFLINE_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    ),
  );
});
