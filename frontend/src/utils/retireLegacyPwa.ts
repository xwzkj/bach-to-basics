// Keep these cache rules in sync with public/sw.js (the old registration URL).
function isAppCache(name: string, scope: string): boolean {
  return name === "smplr-samples" ||
    (name.startsWith("workbox-") && name.endsWith(`-${scope}`));
}

function isAppWorker(worker: ServiceWorker | null, scriptUrl: string): boolean {
  return worker !== null && worker.scriptURL === scriptUrl;
}

/** Best-effort migration only: unavailable browser storage must not block React. */
export function retireLegacyPwa(): void {
  try {
    // The retired PWA used start_url/scope "/" and registered "/sw.js".
    const scope = new URL("/", window.location.href).href;
    const scriptUrl = new URL("sw.js", scope).href;
    const serviceWorker = navigator.serviceWorker;
    let running: Promise<void> | undefined;
    let reloading = false;

    const clean = (): Promise<void> => {
      if (running) return running;
      running = (async () => {
        const hadController = isAppWorker(serviceWorker?.controller ?? null, scriptUrl);
        await Promise.allSettled([
          (async () => {
            if (!serviceWorker) return;
            const registrations = await serviceWorker.getRegistrations();
            await Promise.allSettled(registrations
              .filter((registration) => registration.scope === scope &&
                [registration.active, registration.waiting, registration.installing]
                  .some((worker) => isAppWorker(worker, scriptUrl)))
              .map((registration) => registration.unregister()));
          })(),
          (async () => {
            if (!("caches" in window)) return;
            const names = await window.caches.keys();
            await Promise.allSettled(names
              .filter((name) => isAppCache(name, scope))
              .map((name) => window.caches.delete(name)));
          })(),
        ]);

        // unregister() leaves the current document controlled. A navigation after
        // removal escapes it. The session guard also covers a failed unregister,
        // a controller restored from BFCache, or an old tab re-registering it.
        if ((hadController || isAppWorker(serviceWorker?.controller ?? null, scriptUrl)) && !reloading) {
          const key = "b2b:pwa-retired:v1";
          try {
            if (window.sessionStorage.getItem(key)) return;
            window.sessionStorage.setItem(key, "1");
          } catch {
            // Without a persistent loop guard, wait for the next normal visit.
            return;
          }
          reloading = true;
          window.location.reload();
        }
      })().catch(() => {
        // Privacy settings, an untrusted certificate, or storage failures are
        // migration failures only; never surface an unhandled app-start error.
      }).finally(() => { running = undefined; });
      return running;
    };

    const retry = () => { void clean(); };
    // A worker can claim this page after startup; BFCache can restore control.
    serviceWorker?.addEventListener("controllerchange", retry);
    window.addEventListener("pageshow", retry);
    void clean();
  } catch {
    // Accessing the APIs themselves can throw in restricted browser contexts.
  }
}
