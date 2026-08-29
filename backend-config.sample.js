// FablePeak cloud config — SAMPLE.
// Copy to backend-config.js and fill in real values to switch the app
// from local mode to cloud mode. While backend-config.js is absent the
// app runs 100% local. Only public/anon keys belong here (this file
// ships to every browser); secrets stay server-side. See BACKEND_SPEC.md.
window.FABLEPEAK_BACKEND = {
  provider: "supabase",                        // or "insforge", "firebase", "custom"
  url: "https://YOUR-PROJECT.supabase.co",
  anonKey: "PUBLIC-ANON-KEY",
  scheduleTimezone: "Australia/Perth",         // must match the backend's APP_TIMEZONE
};
