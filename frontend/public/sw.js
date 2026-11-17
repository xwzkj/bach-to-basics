// Retirement worker for existing /sw.js registrations. Keep serving this URL:
// browsers still running a cached old index can update without the new app JS.
// This worker intentionally has no fetch handler and never caches responses.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    try {
      const names = await caches.keys();
      // Workbox's default names end in the registration scope. Other apps on
      // the same origin may have their own caches; leave those untouched.
      await Promise.allSettled(names
        .filter((name) => name === "smplr-samples" ||
          (name.startsWith("workbox-") && name.endsWith(`-${scope}`)))
        .map((name) => caches.delete(name)));
    } catch {
      // Storage restrictions must not prevent the worker from retiring.
    }

    try {
      // Replace old controllers before navigation. With no fetch handler even
      // a failed unregister now falls through to the network.
      await self.clients.claim();
    } catch {
      // Continue with unregister even if a client could not be claimed.
    }

    try {
      await self.registration.unregister();
    } catch {
      // This harmless network-only worker can still free the old pages.
    }

    try {
      const windows = await self.clients.matchAll({ type: "window" });
      // Only claimed clients in our scope. Activation runs once per install;
      // there is no registration on new pages, so navigation cannot loop.
      await Promise.allSettled(windows
        .filter((client) => client.url.startsWith(scope))
        .map((client) => client.navigate(client.url)));
    } catch {
      // Closed tabs and failed/offline navigations should not abort activation.
    }
  })());
});
