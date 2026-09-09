// Custom service worker (injectManifest strategy). Step 1 for local-first:
// app-shell precache + navigation fallback only. API stays network-only,
// especially the SSE stream, which must never be intercepted.
//
// No skipWaiting/clientsClaim on purpose: updates activate on the next
// navigation, so in-memory drafts are never lost to a forced reload.
// A HUD update prompt can gate an update explicitly in a later step.
import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Parameters<typeof precacheAndRoute>[0];
};

precacheAndRoute(self.__WB_MANIFEST);

// NOTE: no route is registered for /api/* on purpose. Routing API traffic
// through NetworkOnly looks equivalent but isn't: any transient network
// failure of the inner fetch rejects through the Router (no catch handler),
// and Chrome reports it as "A ServiceWorker intercepted the request and
// encountered an unexpected error" — e.g. on every offline blip or deploy
// restart for the long-lived SSE stream. With no matching route Workbox
// calls no respondWith, so API traffic stays browser-native and fails like
// ordinary network errors, which the EventSource reconnect already heals.

// App navigations (/, /p/:id) serve the shell offline; the client refetches
// the snapshot and resyncs by rev on boot.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api\//],
  }),
);
