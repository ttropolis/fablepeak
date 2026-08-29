/* =============== ANALYTICS =============== */
import { attr, esc } from "./escape.js";
import { rng } from "./util.js";
import { analyticsNet, metricsCache } from "./state.js";
import { liveMode } from "./store.js";
import { brand, connectedNets } from "./workspace.js";
import { ensureMetricsLoaded, metricSeries, realMetricSeries } from "./metrics.js";

export function lineChart(series, key, color){
  const W=560,H=170,P=28;
  const vals=series.map(s=>s[key]);
  const min=Math.min(...vals), max=Math.max(...vals), span=(max-min)||1;
  const pts=series.map((s,i)=>{
    const x=P+i*(W-2*P)/Math.max(series.length-1,1);
    const y=H-P-(s[key]-min)/span*(H-2*P);
    return [x,y];
  });
  const path=pts.map((p,i)=>(i?"L":"M")+p[0].toFixed(1)+","+p[1].toFixed(1)).join(" ");
  const area=path+` L${pts[pts.length-1][0]},${H-P} L${pts[0][0]},${H-P} Z`;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%">
    <path d="${area}" fill="${attr(color)}22"/><path d="${path}" fill="none" stroke="${attr(color)}" stroke-width="2.5"/>
    <text x="${P}" y="14" font-size="11" fill="#6b7c8d">${max.toLocaleString()}</text>
    <text x="${P}" y="${H-8}" font-size="11" fill="#6b7c8d">${min.toLocaleString()}</text>
    <text x="${W-P}" y="${H-8}" font-size="11" text-anchor="end" fill="#6b7c8d">${series[series.length-1].date.slice(5)}</text>
  </svg>`;
}
export function barChart(series, key, color){
  const W=560,H=170,P=26;
  const vals=series.map(s=>s[key]); const max=Math.max(...vals)||1;
  const bw=(W-2*P)/series.length;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%">
    ${series.map((s,i)=>{
      const h=(s[key]/max)*(H-2*P);
      return `<rect x="${(P+i*bw+1).toFixed(1)}" y="${(H-P-h).toFixed(1)}" width="${Math.max(bw-2,1).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${attr(color)}"/>`;
    }).join("")}
    <text x="${P}" y="14" font-size="11" fill="#6b7c8d">max ${max.toLocaleString()}</text>
  </svg>`;
}
export function bestTimesHeat(){
  const b=brand(); const r=rng(b.seed+42);
  const days=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  let cells=`<div></div>${Array.from({length:24},(_,h)=>`<div class="hh">${h%3===0?h:""}</div>`).join("")}`;
  for(const d of days){
    cells+=`<div class="hl">${d}</div>`;
    for(let h=0;h<24;h++){
      let v=r();
      if(h>=8&&h<=11)v=Math.min(1,v+.35); if(h>=17&&h<=20)v=Math.min(1,v+.45); if(h<6)v*=.2;
      cells+=`<div class="hc" title="${d} ${h}:00 — activity ${(v*100)|0}%" style="background:rgba(34,193,220,${(v*.9+.05).toFixed(2)})"></div>`;
    }
  }
  return `<div class="heat">${cells}</div>`;
}
export function renderAnalytics(m){
  const b=brand();
  ensureMetricsLoaded(b.id);
  const realSeries = realMetricSeries(30, analyticsNet);
  const usingReal = !!realSeries;
  const s = realSeries || metricSeries(30, analyticsNet);
  const last=s[s.length-1];
  const followerSeries = usingReal ? s.filter(x=>x.followersMeasured) : s;
  const firstFollowers = followerSeries[0]?.followers ?? last.followers;
  const fDelta=last.followers-firstFollowers;
  const totEng=s.reduce((a,x)=>a+x.engagement,0), totImp=s.reduce((a,x)=>a+x.impressions,0);
  const monthPosts=usingReal
    ? s.reduce((a,x)=>a+(x.posts||0),0)
    : b.posts.filter(p=>p.status==="published" &&
        (analyticsNet==="all" || p.networks.includes(analyticsNet))).length;
  const engRate=((totEng/Math.max(totImp,1))*100).toFixed(1);
  m.innerHTML=`
  <h1>Analytics</h1>
  <div class="sub">Last 30 days</div>
  <div class="card" style="border-left:4px solid ${usingReal?"var(--chip-pub)":"var(--chip-draft)"};margin-bottom:14px">
    <strong>${usingReal
      ? "● Real platform metrics"
      : metricsCache.loading && liveMode()
        ? "Loading real platform metrics…"
        : "⚠️ These numbers are simulated."}</strong>
    <div style="color:var(--muted);font-size:13px;margin-top:6px">
      ${usingReal
        ? "Pulled from connected platforms by the daily metrics job."
        : metricsCache.error && liveMode()
          ? `Real metrics could not be loaded (${esc(metricsCache.error)}). Showing generated sample data.`
          : "Real analytics start filling in after a connected platform completes its first daily metrics run. Until then, generated sample data demonstrates the layout."}</div>
  </div>
  <div class="tabbar noprint">
    <button class="${analyticsNet==="all"?"active":""}" data-action="analyticsNet" data-arg="all">All networks</button>
    ${connectedNets().map(n=>`<button class="${analyticsNet===n.id?"active":""}" data-action="analyticsNet" data-arg="${attr(n.id)}">${n.name}</button>`).join("")}
  </div>
  <div class="kpis">
    <div class="card kpi"><div class="n">${last.followers.toLocaleString()}</div><div class="l">Followers</div>
      <div class="d ${fDelta>=0?"up":"down"}">${fDelta>=0?"▲":"▼"} ${Math.abs(fDelta).toLocaleString()} this month</div></div>
    <div class="card kpi"><div class="n">${totImp.toLocaleString()}</div><div class="l">Impressions</div></div>
    <div class="card kpi"><div class="n">${totEng.toLocaleString()}</div><div class="l">Engagements</div></div>
    <div class="card kpi"><div class="n">${engRate}%</div><div class="l">Engagement rate</div></div>
    <div class="card kpi"><div class="n">${monthPosts}</div><div class="l">Posts published</div></div>
  </div>
  <div class="row">
    <div class="card chartbox"><h4>Follower growth</h4>${lineChart(followerSeries.length?followerSeries:s,"followers","#22c1dc")}</div>
    <div class="card chartbox"><h4>Daily engagement</h4>${barChart(s,"engagement","#7ee081")}</div>
  </div>
  <div class="card" style="margin-top:14px">
    <h4 style="font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">${usingReal?"Estimated ":""}Best times to post (audience activity)</h4>
    ${bestTimesHeat()}
  </div>`;
}
