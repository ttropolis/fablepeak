// FablePeak cloud config — activates the Supabase backend.
// Only public values here (this file ships to every browser).
// Delete this file to return the whole app to local-only mode.
window.FABLEPEAK_BACKEND = {
  provider: "supabase",
  url: "https://lghsvxwuaebvotutyjtt.supabase.co",
  anonKey: "sb_publishable_XXJWxAPn2q0I5rgSQ6LUPg_oUQTPJ13",
  // Must match the publish Edge Function's APP_TIMEZONE — scheduled times are
  // wall-clock times in this zone, and the composer labels the Time field with it.
  scheduleTimezone: "Australia/Perth",
};
