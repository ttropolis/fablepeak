/* =============== INBOX =============== */
import { attr, esc } from "./escape.js";
import { uid } from "./util.js";
import { inboxFilter, selectedMsg, setSelectedMsg } from "./state.js";
import { brand, netOf, save } from "./workspace.js";
import { render, toast } from "./shell.js";

export function renderInbox(m){
  const b=brand();
  const list=b.inbox.filter(c=> inboxFilter==="all" ? !c.resolved
    : inboxFilter==="unread" ? c.unread && !c.resolved : c.resolved);
  const sel = selectedMsg? b.inbox.find(c=>c.id===selectedMsg) : null;
  m.innerHTML=`
  <h1>Inbox</h1>
  <div class="sub">Messages and comments from every network, in one place.</div>
  <div class="card" style="border-left:4px solid var(--chip-draft);margin-bottom:12px">
    <strong>⚠️ Sample conversations — not real messages.</strong>
    <div style="color:var(--muted);font-size:13px;margin-top:6px">
      Pulling real DMs and comments needs extra permissions that Instagram and Facebook only
      grant after App Review, and TikTok doesn't offer at all. Publishing and analytics work
      without that review; the inbox is the one feature that can't.</div>
  </div>
  <div class="tabbar">
    ${["all","unread","resolved"].map(f=>`<button class="${inboxFilter===f?"active":""}"
        data-action="inboxFilter" data-arg="${attr(f)}">${f[0].toUpperCase()+f.slice(1)}</button>`).join("")}
    <button style="margin-left:auto" data-action="fakeIncoming">＋ Simulate incoming</button>
  </div>
  <div class="inboxwrap">
    <div class="msglist">
      ${list.length? list.map(c=>{
        const n=netOf(c.net);
        return `<button type="button" class="card msg ${c.unread?"unread":""} ${sel&&sel.id===c.id?"sel":""}"
          aria-pressed="${sel&&sel.id===c.id?"true":"false"}" data-action="openMsg" data-arg="${attr(c.id)}">
          <div class="from"><span>${esc(c.from)}</span>
            <span class="nico" style="background:${attr(n.color)};width:22px;height:22px;font-size:9px;border-radius:6px">${n.short}</span></div>
          <div class="prev">${esc(c.msgs[c.msgs.length-1].text)}</div></button>`;
      }).join("") : `<div class="empty">Nothing here 🎉</div>`}
    </div>
    <div class="card thread">
      ${sel? `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong>${esc(sel.from)} · ${netOf(sel.net).name}</strong>
          <button class="btn ghost mini" data-action="toggleResolved" data-arg="${attr(sel.id)}">${sel.resolved?"Reopen":"Mark resolved ✓"}</button>
        </div>
        <div class="bubbles">${sel.msgs.map(x=>`<div class="bub ${attr(x.who)}">${esc(x.text)}</div>`).join("")}</div>
        <div class="replyrow">
          <input type="text" id="replyInp" placeholder="Type a reply…" data-enter="sendReply" data-arg="${attr(sel.id)}">
          <button class="btn" data-action="sendReply" data-arg="${attr(sel.id)}">Send</button>
        </div>`
      : `<div class="empty">Select a conversation</div>`}
    </div>
  </div>`;
  if(sel) document.getElementById("replyInp")?.focus();
}
export function openMsg(id){ setSelectedMsg(id); const c=brand().inbox.find(x=>x.id===id); if(c){c.unread=false; save();} render(); }
export function sendReply(id){
  const inp=document.getElementById("replyInp"); const t=inp.value.trim(); if(!t)return;
  brand().inbox.find(c=>c.id===id).msgs.push({who:"me",text:t}); save(); render(); toast("Reply sent");
}
export function toggleResolved(id){ const c=brand().inbox.find(x=>x.id===id); c.resolved=!c.resolved;
  save(); setSelectedMsg(null); render(); }
export function fakeIncoming(){
  const samples=[["instagram","@new.follower","Love your content! How can I work with you?"],
    ["x","@curious_dev","Is there an API for this?"],
    ["tiktok","@trendwatcher","That last video was 🔥🔥"],
    ["facebook","Miguel R.","Do you have any discounts this month?"]];
  const [net,from,text]=samples[Math.floor(Math.random()*samples.length)];
  brand().inbox.unshift({id:uid(),net,from,resolved:false,unread:true,msgs:[{who:"them",text}]});
  save(); render(); toast("New message received");
}
