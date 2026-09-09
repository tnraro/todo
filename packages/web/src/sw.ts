// Custom service worker (injectManifest strategy). Step 1 for local-first:
// app-shell precache + navigation fallback only. API stays network-only,
// especially the SSE stream, which must never be intercepted.
//
// No skipWaiting/clientsClaim on purpose: updates activate on the next
// navigation, so in-memory drafts are never lost to a forced reload.
// A HUD update prompt can gate an update explicitly in a later step.
import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkOnly } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Parameters<typeof precacheAndRoute>[0];
};

precacheAndRoute(self.__WB_MANIFEST);

// REST + SSE bypass the SW entirely: default would already pass through,
// but explicit is safer than relying on no-route-matches behavior.
registerRoute(({ url }) => url.pathname.startsWith("/api/"), new NetworkOnly());

// App navigations (/, /p/:id) serve the shell offline; the client refetches
// the snapshot and resyncs by rev on boot.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api\//],
  }),
);
