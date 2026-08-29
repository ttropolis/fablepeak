/* Metric series for Analytics and Reports: a deterministic simulation for
   local/demo workspaces, and the real daily rows once ingest-metrics has run. */
import { NETWORKS } from "./constants.js";
import { fmtDate, rng } from "./util.js";
import { metricsCache, setMetricsCache, view } from "./state.js";
import { liveMode, store } from "./store.js";
import { brand } from "./workspace.js";
import { render } from "./shell.js";

/* =============== deterministic demo metrics =============== */
export function metricSeries(days, netId){
  // followers + daily engagement for last `days` days, deterministic per brand+network
  const b = brand();
  const seedN = b.seed + (netId==="all"?0:NETWORKS.findIndex(n=>n.id===netId)*97);
  const r = rng(seedN+1);
  const baseF = 800 + Math.floor(r()*9000);
  const out=[];
  let f = baseF;
  for(let i=days-1;i>=0;i--){
    const d = new Date(); d.setDate(d.getDate()-i);
    const ds = fmtDate(d);
    f += Math.floor(r()*40 - 8);
    const posted = b.posts.filter(p=>p.date===ds && p.status==="published" &&
      (netId==="all" || p.networks.includes(netId))).length;
    const eng = Math.floor(r()*120 + posted*260);
    const imp = Math.floor(eng * (14 + r()*10));
    out.push({date:ds, followers:f, engagement:eng, impressions:imp});
  }
  return out;
}

/* Build chart-ready daily rows from metrics_daily. Platform APIs expose
   followers, impressions and engagements as cumulative snapshots, while
   posts is already measured per day by ingest-metrics. Carry follower totals
   forward and turn cumulative counters into non-negative daily deltas. */
export function realMetricSeries(days, netId){
  if(!liveMode() || !metricsCache.loaded ||
     metricsCache.brandId !== brand().id || metricsCache.error) return null;
  const rows = metricsCache.rows.filter(r=>netId==="all" || r.platform===netId);
  if(!rows.length) return null;

  const platforms = netId==="all"
    ? [...new Set(rows.map(r=>r.platform))]
    : [netId];
  const sortedRows = [...rows].sort((a,b)=>a.date.localeCompare(b.date));
  const byDate = {};
  sortedRows.forEach(r=>{ (byDate[r.date]=byDate[r.date]||[]).push(r); });
  const lastFollowers = {};
  const lastCounters = {};
  const start = new Date(); start.setDate(start.getDate()-(days-1));
  const startDate = fmtDate(start);
  // ensureMetricsLoaded fetches extra calendar days so the first visible day
  // can be compared with a real baseline instead of counting a lifetime total.
  sortedRows.filter(r=>r.date<startDate).forEach(r=>{
    if(r.followers!=null) lastFollowers[r.platform] = Number(r.followers) || 0;
    const state = lastCounters[r.platform] ||= {};
    if(r.impressions!=null) state.impressions = Number(r.impressions) || 0;
    if(r.engagements!=null) state.engagements = Number(r.engagements) || 0;
  });
  const out = [];
  for(let i=days-1;i>=0;i--){
    const d = new Date(); d.setDate(d.getDate()-i);
    const date = fmtDate(d);
    const daily = byDate[date] || [];
    let impressions = 0, engagement = 0;
    daily.forEach(r=>{
      if(r.followers != null) lastFollowers[r.platform] = Number(r.followers) || 0;
      const state = lastCounters[r.platform] ||= {};
      [["impressions","impressions"],["engagements","engagement"]].forEach(([field,total])=>{
        if(r[field]==null) return;
        const current = Number(r[field]) || 0;
        const previous = state[field];
        // A lower value indicates a platform-side counter reset. In that
        // case, the new counter value is the activity since the reset.
        const delta = previous==null ? 0 : current>=previous ? current-previous : current;
        if(total==="impressions") impressions += delta; else engagement += delta;
        state[field] = current;
      });
    });
    out.push({
      date,
      followers: platforms.reduce((sum,p)=>sum+(lastFollowers[p]||0),0),
      followersMeasured: platforms.some(p=>lastFollowers[p]!=null),
      impressions,
      engagement,
      posts: daily.reduce((sum,r)=>sum+(Number(r.posts)||0),0),
    });
  }
  return out;
}

export function ensureMetricsLoaded(brandId){
  if(!liveMode()) return;
  if(metricsCache.brandId===brandId && (metricsCache.loaded || metricsCache.loading)) return;
  setMetricsCache({brandId, rows:[], loaded:false, loading:true, error:null});
  // Two extra days keep a baseline available across UTC/local date boundaries.
  store.listMetrics(brandId, 32).then(rows=>{
    if(metricsCache.brandId !== brandId) return;
    setMetricsCache({brandId, rows, loaded:true, loading:false, error:null});
    if(["analytics","reports"].includes(view)) render();
  }).catch(e=>{
    if(metricsCache.brandId !== brandId) return;
    setMetricsCache({
      brandId, rows:[], loaded:true, loading:false,
      error: String(e.message || e),
    });
    if(["analytics","reports"].includes(view)) render();
  });
}
