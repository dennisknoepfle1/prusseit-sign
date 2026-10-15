// Minimaler Service Worker: macht die App installierbar und ist Grundlage für Push.
// Kein Offline-Cache, damit immer die aktuelle Version geladen wird.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
