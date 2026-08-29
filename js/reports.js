/* =============== REPORTS =============== */
import { NETWORKS } from "./constants.js";
import { attr, esc } from "./escape.js";
import { metricsCache } from "./state.js";
import { brand, connectedNets, netOf } from "./workspace.js";
import { ensureMetricsLoaded, metricSeries, realMetricSeries } from "./metrics.js";

export function renderReports(m){
  const b=brand();
  ensureMetricsLoaded(b.id);
  const realSeries=realMetricSeries(30,"all");
  const usingReal=!!realSeries;
  const s=realSeries||metricSeries(30,"all");
  const pub=b.posts.filter(p=>p.status==="published");
  const reportNetworks=usingReal
    ? NETWORKS.filter(n=>metricsCache.rows.some(r=>r.platform===n.id))
    : NETWORKS;
  const perNet=reportNetworks.map(n=>{
    const posts=pub.filter(p=>p.networks.includes(n.id));
    if(!usingReal && !posts.length && !connectedNets().some(c=>c.id===n.id)) return null;
    const ser=usingReal ? realMetricSeries(30,n.id) : metricSeries(30,n.id);
    if(!ser) return null;
    return {n, posts:posts.length,
      followers:ser[ser.length-1].followers,
      eng:ser.reduce((a,x)=>a+x.engagement,0),
      imp:ser.reduce((a,x)=>a+x.impressions,0),
      measuredPosts:ser.reduce((a,x)=>a+(x.posts||0),0)};
  }).filter(Boolean);
  const totEng=s.reduce((a,x)=>a+x.engagement,0), totImp=s.reduce((a,x)=>a+x.impressions,0);
  const totalPosts=usingReal?s.reduce((a,x)=>a+(x.posts||0),0):pub.length;
  m.innerHTML=`
  <h1>Report — ${esc(b.name)}</h1>
  <div class="sub">Last 30 days · ${usingReal?"real platform metrics":"simulated metrics"} · generated ${new Date().toLocaleDateString()}
    <button class="btn mini noprint" style="margin-left:10px" data-action="printReport">🖨 Print / Save as PDF</button></div>
  <div class="kpis">
    <div class="card kpi"><div class="n">${s[s.length-1].followers.toLocaleString()}</div><div class="l">Total followers</div></div>
    <div class="card kpi"><div class="n">${totImp.toLocaleString()}</div><div class="l">Impressions</div></div>
    <div class="card kpi"><div class="n">${totEng.toLocaleString()}</div><div class="l">Engagements</div></div>
    <div class="card kpi"><div class="n">${totalPosts}</div><div class="l">Posts published</div></div>
  </div>
  <div class="card">
    <h4 style="font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Performance by network</h4>
    <table class="rep">
      <tr><th>Network</th><th>Followers</th><th>Impressions</th><th>Engagements</th><th>Posts</th></tr>
      ${perNet.map(r=>`<tr>
        <td><span style="color:${attr(r.n.color)};font-weight:700">${r.n.short}</span> ${r.n.name}</td>
        <td>${r.followers.toLocaleString()}</td><td>${r.imp.toLocaleString()}</td>
        <td>${r.eng.toLocaleString()}</td><td>${usingReal?r.measuredPosts:r.posts}</td></tr>`).join("")}
    </table>
  </div>
  <div class="card" style="margin-top:14px">
    <h4 style="font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Published posts</h4>
    ${pub.length? `<table class="rep"><tr><th>Date</th><th>Content</th><th>Networks</th></tr>
      ${pub.sort((a,b)=>b.date.localeCompare(a.date)).map(p=>`<tr>
        <td style="white-space:nowrap">${p.date}</td><td>${esc(p.text)}</td>
        <td>${p.networks.map(n=>netOf(n)?.short).join(", ")}</td></tr>`).join("")}</table>`
      : `<div class="empty">No published posts yet.</div>`}
  </div>`;
}
