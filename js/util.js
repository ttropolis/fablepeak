/* Small pure helpers with no DOM and no app state. */

export const uid = () => Math.random().toString(36).slice(2,10);
export const fmtDate = d => d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
export const todayStr = () => fmtDate(new Date());

export const MEDIA_TYPES = {
  jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", webp:"image/webp", gif:"image/gif",
  mp4:"video/mp4", mov:"video/quicktime", m4v:"video/mp4", webm:"video/webm",
};
export function mediaContentType(file){
  const supplied=(file?.type||"").toLowerCase().split(";",1)[0];
  if(Object.values(MEDIA_TYPES).includes(supplied)) return supplied;
  const ext=(file?.name||"").split(".").pop().toLowerCase();
  return MEDIA_TYPES[ext] || "";
}
export function fileSizeLabel(bytes){
  return bytes<1024*1024 ? `${Math.max(1,Math.round(bytes/1024))} KB` : `${(bytes/1024/1024).toFixed(1)} MB`;
}

/** Deterministic PRNG — the demo metrics and the best-times heatmap are seeded
    per brand so the same workspace always draws the same picture. */
export function rng(seed){ let s=seed%2147483647; if(s<=0)s+=2147483646;
  return ()=> (s = s*16807 % 2147483647) / 2147483647; }
