import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retireLegacyPwa } from "../utils/retireLegacyPwa";

const scope = "https://piano.test/";
const scriptURL = `${scope}sw.js`;
let browser: EventTarget & Record<string, any>;
let workers: EventTarget & Record<string, any>;
let storage: Map<string, string>;

function registration(workerScript = scriptURL, workerScope = scope, state = "active") {
  return {
    scope: workerScope,
    active: null,
    waiting: null,
    installing: null,
    [state]: { scriptURL: workerScript },
    unregister: vi.fn().mockResolvedValue(true),
  };
}

// All migration APIs below resolve without timers; drain their chained promises.
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

beforeEach(() => {
  storage = new Map();
  workers = Object.assign(new EventTarget(), {
    controller: null,
    getRegistrations: vi.fn().mockResolvedValue([]),
  });
  browser = Object.assign(new EventTarget(), {
    location: { href: `${scope}?piece=1#practice`, reload: vi.fn() },
    sessionStorage: {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    },
    caches: {
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
    },
  });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("navigator", { serviceWorker: workers });
});
afterEach(() => vi.unstubAllGlobals());

describe("retireLegacyPwa", () => {
  it("removes only the old app registration and its Workbox/sample caches", async () => {
    const app = registration();
    const waiting = registration(scriptURL, scope, "waiting");
    const otherApp = registration(`${scope}other/sw.js`, `${scope}other/`);
    const otherRootWorker = registration(`${scope}different-worker.js`);
    workers.getRegistrations.mockResolvedValue([app, waiting, otherApp, otherRootWorker]);
    browser.caches.keys.mockResolvedValue([
      `workbox-precache-v2-${scope}`, `workbox-runtime-${scope}`,
      "smplr-samples", `workbox-precache-v2-${scope}other/`, "user-scores",
      `unrelated-${scope}`, "workbox-precache-v2-https://elsewhere.test/",
    ]);

    retireLegacyPwa();
    await settle();

    expect(app.unregister).toHaveBeenCalledOnce();
    expect(waiting.unregister).toHaveBeenCalledOnce();
    expect(otherApp.unregister).not.toHaveBeenCalled();
    expect(otherRootWorker.unregister).not.toHaveBeenCalled();
    expect(browser.caches.delete.mock.calls.map(([name]: [string]) => name)).toEqual([
      `workbox-precache-v2-${scope}`, `workbox-runtime-${scope}`, "smplr-samples",
    ]);
    expect(browser.location.reload).not.toHaveBeenCalled();
  });

  it("navigates out of old control once, including on a fresh helper invocation", async () => {
    const app = registration();
    workers.controller = { scriptURL };
    workers.getRegistrations.mockResolvedValue([app]);
    retireLegacyPwa();
    await settle();
    expect(app.unregister).toHaveBeenCalledOnce();
    expect(browser.location.reload).toHaveBeenCalledOnce();
    workers.dispatchEvent(new Event("controllerchange"));
    browser.dispatchEvent(new Event("pageshow"));
    await settle();
    retireLegacyPwa();
    await settle();
    expect(browser.location.reload).toHaveBeenCalledOnce();
  });

  it("handles a late claim and a page restored from BFCache", async () => {
    retireLegacyPwa();
    await settle();
    expect(browser.location.reload).not.toHaveBeenCalled();
    workers.controller = { scriptURL };
    workers.dispatchEvent(new Event("controllerchange"));
    await settle();
    expect(browser.location.reload).toHaveBeenCalledOnce();
    const restored = registration();
    workers.getRegistrations.mockResolvedValue([restored]);
    browser.dispatchEvent(new Event("pageshow"));
    await settle();
    expect(restored.unregister).toHaveBeenCalledOnce();
    expect(browser.location.reload).toHaveBeenCalledOnce();
  });

  it("observes a claim occurring during the initial asynchronous cleanup", async () => {
    retireLegacyPwa();
    workers.controller = { scriptURL };
    workers.dispatchEvent(new Event("controllerchange"));
    await settle();
    expect(browser.location.reload).toHaveBeenCalledOnce();
  });

  it("does not reload a page controlled by another app", async () => {
    workers.controller = { scriptURL: `${scope}other/sw.js` };
    retireLegacyPwa();
    await settle();
    expect(browser.location.reload).not.toHaveBeenCalled();
  });

  it("isolates individual unregister/cache errors and storage guard failures", async () => {
    const bad = registration();
    const good = registration();
    bad.unregister.mockRejectedValue(new Error("denied"));
    workers.getRegistrations.mockResolvedValue([bad, good]);
    workers.controller = { scriptURL };
    browser.caches.keys.mockResolvedValue([`workbox-precache-v2-${scope}`, "smplr-samples"]);
    browser.caches.delete.mockRejectedValueOnce(new Error("denied"));
    browser.sessionStorage.getItem.mockImplementation(() => { throw new Error("denied"); });
    expect(() => retireLegacyPwa()).not.toThrow();
    await settle();
    expect(good.unregister).toHaveBeenCalledOnce();
    expect(browser.caches.delete).toHaveBeenCalledTimes(2);
    expect(browser.location.reload).not.toHaveBeenCalled();
  });

  it("handles API-level failures without rejecting or blocking startup", async () => {
    workers.getRegistrations.mockRejectedValue(new Error("denied"));
    browser.caches.keys.mockRejectedValue(new Error("denied"));
    expect(() => retireLegacyPwa()).not.toThrow();
    await settle();
    vi.stubGlobal("navigator", Object.defineProperty({}, "serviceWorker", {
      get: () => { throw new Error("denied"); },
    }));
    expect(() => retireLegacyPwa()).not.toThrow();
  });

  it("still clears caches in browsers without service worker support", async () => {
    vi.stubGlobal("navigator", {});
    browser.caches.keys.mockResolvedValue(["smplr-samples"]);
    retireLegacyPwa();
    await settle();
    expect(browser.caches.delete).toHaveBeenCalledWith("smplr-samples");
    expect(browser.location.reload).not.toHaveBeenCalled();
  });
});
