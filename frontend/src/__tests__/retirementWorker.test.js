import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const scope = "https://piano.test/";

function setup() {
  const listeners = new Map();
  const order = [];
  const app = { url: `${scope}?piece=1#practice`, navigate: vi.fn(async () => { order.push("navigate"); }) };
  const unrelated = { url: "https://another.test/", navigate: vi.fn() };
  const self = {
    addEventListener: vi.fn((type, listener) => listeners.set(type, listener)),
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    registration: {
      scope,
      unregister: vi.fn(async () => { order.push("unregister"); return true; }),
    },
    clients: {
      claim: vi.fn(async () => { order.push("claim"); }),
      matchAll: vi.fn().mockResolvedValue([app, unrelated]),
    },
  };
  const caches = {
    keys: vi.fn().mockResolvedValue([
      `workbox-precache-v2-${scope}`, `workbox-runtime-${scope}`,
      "smplr-samples", `workbox-precache-v2-${scope}other/`, "user-scores",
    ]),
    delete: vi.fn(async () => { order.push("delete"); return true; }),
  };
  runInNewContext(source, { self, caches });
  const dispatch = async (type) => {
    const work = [];
    listeners.get(type)({ waitUntil: (promise) => work.push(promise) });
    await Promise.all(work);
  };
  return { self, caches, app, unrelated, order, listeners, dispatch };
}

describe("legacy /sw.js retirement worker", () => {
  it("replaces a cached old shell without requiring any new page code", async () => {
    const h = setup();
    await h.dispatch("install");
    expect(h.self.skipWaiting).toHaveBeenCalledOnce();
    await h.dispatch("activate");
    expect(h.caches.delete.mock.calls).toEqual([
      [`workbox-precache-v2-${scope}`], [`workbox-runtime-${scope}`], ["smplr-samples"],
    ]);
    expect(h.order).toEqual(["delete", "delete", "delete", "claim", "unregister", "navigate"]);
    expect(h.self.clients.matchAll).toHaveBeenCalledWith({ type: "window" });
    expect(h.app.navigate).toHaveBeenCalledExactlyOnceWith(h.app.url);
    expect(h.unrelated.navigate).not.toHaveBeenCalled();
    expect([...h.listeners.keys()]).toEqual(["install", "activate"]);
  });

  it("continues retirement and navigation when cache storage is inaccessible", async () => {
    const h = setup();
    h.caches.keys.mockRejectedValue(new Error("denied"));
    await expect(h.dispatch("activate")).resolves.toBeUndefined();
    expect(h.order).toEqual(["claim", "unregister", "navigate"]);
  });

  it("does not let individual cache and tab failures abort other migrations", async () => {
    const h = setup();
    h.caches.delete.mockRejectedValueOnce(new Error("denied"));
    h.app.navigate.mockRejectedValueOnce(new Error("closed tab"));
    await expect(h.dispatch("activate")).resolves.toBeUndefined();
    expect(h.caches.delete).toHaveBeenCalledTimes(3);
    expect(h.self.registration.unregister).toHaveBeenCalledOnce();
  });

  it("still unregisters after failed claim and navigates after failed unregister", async () => {
    const h = setup();
    h.self.clients.claim.mockRejectedValue(new Error("claim denied"));
    h.self.registration.unregister.mockRejectedValue(new Error("unregister denied"));
    await expect(h.dispatch("activate")).resolves.toBeUndefined();
    expect(h.self.registration.unregister).toHaveBeenCalledOnce();
    expect(h.app.navigate).toHaveBeenCalledExactlyOnceWith(h.app.url);
    expect(h.listeners.has("fetch")).toBe(false);
  });
});
