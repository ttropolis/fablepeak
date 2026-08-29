/* The workspace lifecycle: seeding, loading, saving, and the small questions
   every view asks about the brand it is rendering. */
import { LEGACY_KEYS, LS_KEY, NETWORKS } from "./constants.js";
import { fmtDate, uid } from "./util.js";
import { db, connCache, metricsCache, slCache, setDb, view } from "./state.js";
import { demoMode, liveMode, store } from "./store.js";
import { RemoteAdapter } from "./remote-store.js";
import { render, toast } from "./shell.js";
import { hideWelcome, showWelcome } from "./welcome.js";
import { refreshConnections } from "./connections.js";

export function defaultBrand(name){
  const b = {
    id: uid(), name,
    seed: Math.floor(Math.random()*10000),
    connections: {}, posts: [], inbox: [],
    smartlink: { title:name, bio:"Welcome! All my links in one place.", avatar:"🚀", color:"#22c1dc",
      links:[{id:uid(),title:"Our website",url:"https://example.com",clicks:132},
             {id:uid(),title:"Latest video",url:"https://example.com/video",clicks:87},
             {id:uid(),title:"Newsletter",url:"https://example.com/news",clicks:45}] }
  };
  return b;
}
export function seedDemo(){
  const b = defaultBrand("My Brand");
  b.connections = {instagram:"@mybrand", x:"@mybrand", linkedin:"my-brand", tiktok:"@mybrand"};
  const base = new Date();
  const mk = (dayOff,hour,text,nets,status)=>{
    const d = new Date(base); d.setDate(d.getDate()+dayOff);
    return {id:uid(), date:fmtDate(d), time:String(hour).padStart(2,"0")+":00",
            text, networks:nets, status};
  };
  b.posts = [
    mk(-6,10,"Behind the scenes: how we build our product 🛠",["instagram","tiktok"],"published"),
    mk(-4,15,"5 lessons we learned this quarter — a thread 🧵",["x","linkedin"],"published"),
    mk(-2,9,"Customer story: +40% growth in 3 months 🚀",["linkedin"],"published"),
    mk(0,18,"New feature drop! Check the link in bio ✨",["instagram","x","facebook"],"scheduled"),
    mk(1,11,"Weekly tips: batch your content on Mondays",["instagram"],"scheduled"),
    mk(3,17,"Live Q&A this Friday — drop your questions 👇",["instagram","tiktok"],"scheduled"),
    mk(5,12,"Draft: monthly recap carousel",["instagram","linkedin"],"draft"),
  ];
  b.inbox = [
    {id:uid(), net:"instagram", from:"@sofia.designs", resolved:false, unread:true,
     msgs:[{who:"them",text:"Hi! Do you ship internationally?"}]},
    {id:uid(), net:"x", from:"@devmarcus", resolved:false, unread:true,
     msgs:[{who:"them",text:"Loved the thread on quarterly lessons. Any chance of a blog version?"}]},
    {id:uid(), net:"facebook", from:"Laura P.", resolved:false, unread:false,
     msgs:[{who:"them",text:"What are your support hours?"},{who:"me",text:"Hi Laura! Mon–Fri, 9–18h CET 😊"},{who:"them",text:"Perfect, thanks!"}]},
    {id:uid(), net:"linkedin", from:"Carlos M. (Acme Corp)", resolved:true, unread:false,
     msgs:[{who:"them",text:"Interested in a partnership. Who should I talk to?"},{who:"me",text:"Hi Carlos, just sent you our partnerships deck!"}]},
  ];
  return {brands:[b], activeBrand:b.id};
}

export async function load(){
  try{ await store.init(); }
  catch(e){ if(store===RemoteAdapter) toast("Cloud unavailable — reconnect to sign in, or explore the demo"); }
  // Cloud mode, signed out, not exploring the demo → welcome gate.
  if(store.name === "cloud" && !store.user && !demoMode()){
    setDb({ brands: [], activeBrand: null });
    showWelcome();
    return;
  }
  hideWelcome();
  try{ setDb(await store.load()); }catch(e){ setDb(null); }
  if(!db && demoMode()){ // demo persists locally between visits
    try{ setDb(JSON.parse(localStorage.getItem(LS_KEY))); }catch(e){}
  }
  if(!db){ // migrate data saved under a previous app name
    for(const k of LEGACY_KEYS){
      try{ const old = JSON.parse(localStorage.getItem(k));
        if(old && old.brands){ setDb(old); save(); break; } }catch(e){}
    }
  }
  if(!db || !db.brands || !db.brands.length){
    if(store.name === "local" || demoMode()){ setDb(seedDemo()); save(); }
    else setDb({ brands: [], activeBrand: null });   // signed in, fresh account → onboarding
  }
  store.onRemoteChange(fresh => {
    setDb(fresh);
    if(["analytics","reports"].includes(view)) metricsCache.loaded = false;
    if(view === "smartlinks") slCache.loaded = false;
    render();
  });
  // know which real accounts are connected before the composer is opened
  if(liveMode() && db.brands.length) refreshConnections(db.activeBrand || db.brands[0].id);
}
let _persistT = null;
export function save(){                        // sync signature, debounced async persist
  clearTimeout(_persistT);
  _persistT = setTimeout(() => {
    store.persist(db).catch(e => {
      console.error("FablePeak save failed:", e);   // silent cloud failures caused a real bug
      toast(store.name==="local"
        ? "⚠️ Could not save — storage full. Export a backup and delete old posts."
        : "⚠️ Cloud save failed: " + String(e.message || e).slice(0, 90));
    });
  }, 200);
}
export async function persistNow(){
  clearTimeout(_persistT); _persistT = null;
  await store.persist(db);
}
export function brand(){ return db.brands.find(b=>b.id===db.activeBrand) || db.brands[0]; }
export function netOf(id){ return NETWORKS.find(n=>n.id===id); }
export function connectedNets(){
  // live mode: the real OAuth-connected accounts; otherwise the simulated ones
  if(typeof liveMode === "function" && liveMode() && connCache.loaded && connCache.brandId === brand().id){
    return NETWORKS.filter(n => connCache.accounts.some(a => a.platform === n.id && a.status === "active"));
  }
  return NETWORKS.filter(n=>brand().connections[n.id]);
}
/* In live mode the real accounts arrive asynchronously, and connectedNets()
   falls back to the simulated ones until they do. An unloaded cache means
   "not known yet", not "nothing connected" — never warn on it. */
export function connectionsKnown(){
  return !liveMode() || (connCache.loaded && connCache.brandId === brand().id);
}

/* Simulated auto-publish is local/demo-only.
   Signed-in cloud workspaces are claimed and published by the server. */
export function tickPublish(){
  if(store.name === "cloud" && store.user) return;
  const now = new Date();
  let changed = false;
  db.brands.forEach(b=>b.posts.forEach(p=>{
    if(p.status==="scheduled" && new Date(p.date+"T"+(p.time||"09:00")) <= now){
      p.status="published"; changed=true;
    }
  }));
  if(changed) save();
}
