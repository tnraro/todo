import { render } from "@solidjs/web";
import App from "./App";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("#app missing");
render(() => <App />, root);

// Manual registration with the default SW lifecycle: updates activate on the
// next navigation, never force-reloading away in-memory drafts. Dev builds
// skip it (no SW is emitted there).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Offline-first is progressive enhancement; the app works without it.
  });
}
