/* Which adapter this deployment runs on, and the two questions the UI asks
   about it. Deleting backend-config.js returns the app to 100% local mode. */
import { LocalAdapter } from "./local-store.js";
import { RemoteAdapter } from "./remote-store.js";
import { DEMO_KEY } from "./constants.js";

/* backend-config.js assigns `window.FABLEPEAK_BACKEND`; `globalThis` is that
   same object in a browser, and is also defined when a unit test imports this
   module outside a page. */
export const store = globalThis.FABLEPEAK_BACKEND ? RemoteAdapter : LocalAdapter;

/* True when we can actually talk to platform APIs: cloud backend + signed in. */
export const liveMode = () => store.name === "cloud" && !!store.user;

export const demoMode = () => localStorage.getItem(DEMO_KEY) === "1";
