/* Shared vocabulary — the values more than one view needs to agree on.
   Constants used by exactly one module live beside their use instead. */

export const NETWORKS = [
  {id:"instagram", name:"Instagram", short:"IG", color:"#d6437f"},
  {id:"x",         name:"X / Twitter", short:"X",  color:"#111111"},
  {id:"facebook",  name:"Facebook",  short:"FB", color:"#1877f2"},
  {id:"linkedin",  name:"LinkedIn",  short:"LI", color:"#0a66c2"},
  {id:"tiktok",    name:"TikTok",    short:"TT", color:"#00b7b0"},
  {id:"youtube",   name:"YouTube",   short:"YT", color:"#e04040"},
  {id:"pinterest", name:"Pinterest", short:"PN", color:"#bd2126"},
  {id:"gbp",       name:"Google Business", short:"GB", color:"#34a853"},
];
export const VIEWS = [
  {id:"planner",    ic:"🗓",  name:"Planner"},
  {id:"analytics",  ic:"📈", name:"Analytics"},
  {id:"inbox",      ic:"💬", name:"Inbox"},
  {id:"smartlinks", ic:"🔗", name:"SmartLinks"},
  {id:"reports",    ic:"📄", name:"Reports"},
  {id:"connections",ic:"🔌", name:"Connections"},
  {id:"settings",   ic:"⚙️", name:"Settings"},
];
/* ADR 0006 decision 6: the one sentence every owner-gated control explains
   itself with. The database is what enforces the rule — this is the affordance,
   so it must say the same thing everywhere it appears. */
export const OWNER_ONLY_TITLE = "Only workspace owners can change this.";

export const APP_VERSION = "1.5.0";
export const LS_KEY = "fablepeak_v1";
export const LEGACY_KEYS = ["metricoolito_v1"];
export const DEMO_KEY = "fablepeak_demo";

/* Cloud posts are published server-side by the publish Edge Function, which
   reads each post's date/time as wall-clock time in APP_TIMEZONE. Deployments
   set it in backend-config.js; the fallback matches the Edge Function default.
   Local/demo publishing is simulated in the browser, so it uses browser time.

   backend-config.js assigns `window.FABLEPEAK_BACKEND`; this module reads it
   off `globalThis`, which is the same object in a browser and is also defined
   when a unit test imports this module outside a page. */
export const SCHEDULE_TZ = globalThis.FABLEPEAK_BACKEND?.scheduleTimezone || "Australia/Perth";
