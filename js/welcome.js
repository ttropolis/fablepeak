/* =============== welcome gate (cloud mode, signed out) =============== */
import { DEMO_KEY } from "./constants.js";
import { setWMode, wMode } from "./state.js";
import { store } from "./store.js";
import { load } from "./workspace.js";
import { handleLaunchAction, render, toast } from "./shell.js";

export function showWelcome(){
  const w = document.getElementById("welcome");
  document.querySelector("aside").inert = true;
  document.getElementById("main").inert = true;
  // Do not leave the previous workspace visible or exposed in the DOM behind
  // the signed-out gate. render() rebuilds it after demo entry or sign-in.
  document.getElementById("main").replaceChildren();
  document.getElementById("nav").replaceChildren();
  document.getElementById("brandSel").replaceChildren();
  w.hidden = false;
  w.innerHTML = `
  <div class="wwrap">
    <div class="whero">
      <div class="wlogo">⛰️ Fable<span>Peak</span></div>
      <h2>All your social media, one clean workspace.</h2>
      <p class="tag">Plan your content calendar, answer every message, track what works,
        and share one link-in-bio — without juggling ten tabs.</p>
      <ul class="wfeat">
        <li><span class="fi">🗓</span> Visual planner — schedule posts across Instagram, Facebook, YouTube and more</li>
        <li><span class="fi">📈</span> Analytics and best-times heatmap that read themselves</li>
        <li><span class="fi">💬</span> One inbox for every network's messages</li>
        <li><span class="fi">🔗</span> Link-in-bio pages with click tracking</li>
        <li><span class="fi">📱</span> Installs on your phone, works offline, syncs everywhere</li>
      </ul>
      <div class="wsmall">Private by design — your workspace is yours alone.</div>
    </div>
    <div class="wcard">
      <div class="wtabs">
        <button class="${wMode==='signin'?'on':''}" data-action="wTab" data-arg="signin">Sign in</button>
        <button class="${wMode==='signup'?'on':''}" data-action="wTab" data-arg="signup">Create account</button>
      </div>
      <label class="f">Email</label>
      <input type="email" id="w_email" placeholder="you@example.com" autocomplete="email">
      <label class="f">Password</label>
      <input type="password" id="w_pw" placeholder="${wMode==='signup'?'Min 8 characters':'Your password'}"
        autocomplete="${wMode==='signup'?'new-password':'current-password'}"
        data-enter="wSubmit">
      <div class="werr" id="w_err"></div>
      <button class="btn wsubmit" data-action="wSubmit">${wMode==='signin'?'Sign in':'Create my account'}</button>
      ${wMode==='signin' ? `<button class="btn ghost wdemo" style="margin-top:8px" data-action="requestPasswordReset">Forgot password?</button>` : ""}
      <div class="wdivide">or</div>
      <button class="btn ghost wdemo" data-action="enterDemo">👀 Explore the demo first</button>
      <div class="wfoot">Demo runs entirely in your browser with sample data.<br>No account, nothing uploaded.<br>
        <a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · <a href="/data-deletion.html">Data deletion</a></div>
    </div>
  </div>`;
  // Avoid covering the welcome actions with the software keyboard on phones.
  if(window.matchMedia("(min-width: 821px)").matches) document.getElementById("w_email").focus();
}
export function hideWelcome(){
  const w=document.getElementById("welcome");
  w.hidden=true; w.innerHTML="";
  document.querySelector("aside").inert = false;
  document.getElementById("main").inert = false;
}
export function wTab(m){ setWMode(m); showWelcome(); }
export function wSubmit(){
  const email=document.getElementById("w_email").value.trim();
  const pw=document.getElementById("w_pw").value;
  const err=document.getElementById("w_err");
  if(!email || !pw){ err.textContent="Email and password, please."; return; }
  if(wMode==="signup" && pw.length<8){ err.textContent="Use at least 8 characters."; return; }
  err.textContent="";
  const done = () => load().then(()=>{ render(); handleLaunchAction(); toast(wMode==='signin'?"Welcome back ✔":"Account created ✔"); });
  if(wMode==="signin"){
    store.signIn(email,pw).then(done).catch(e=>err.textContent=e.message);
  }else{
    store.signUp(email,pw).then(r=>{
      if(r==="active") done();
      else{ err.textContent=""; document.querySelector(".wnote")?.remove();
        err.insertAdjacentHTML("afterend",
          `<div class="wnote">✉️ Check your inbox — click the confirmation link, then sign in here.</div>`); }
    }).catch(e=>err.textContent=e.message);
  }
}
export async function requestPasswordReset(){
  const email=document.getElementById("w_email").value.trim();
  const err=document.getElementById("w_err");
  if(!email){ err.textContent="Enter your email address first."; return; }
  try{
    await store.sendPasswordReset(email);
    err.textContent="";
    err.insertAdjacentHTML("afterend", `<div class="wnote">✉️ Password reset link sent. Check your inbox.</div>`);
  }catch(e){ err.textContent=e.message; }
}
export function showPasswordReset(){
  const w=document.getElementById("welcome");
  w.hidden=false;
  w.innerHTML=`<div class="wwrap"><div class="wcard" style="max-width:440px;margin:auto">
    <div class="wlogo">⛰️ Fable<span>Peak</span></div>
    <h2 style="margin:20px 0 6px">Choose a new password</h2>
    <p class="wsmall">Use at least 8 characters.</p>
    <label class="f">New password</label>
    <input type="password" id="reset_pw" autocomplete="new-password" placeholder="Min 8 characters"
      data-enter="completePasswordReset">
    <div class="werr" id="reset_err"></div>
    <button class="btn wsubmit" data-action="completePasswordReset">Update password</button>
  </div></div>`;
  if(window.matchMedia("(min-width: 821px)").matches) document.getElementById("reset_pw").focus();
}
export async function completePasswordReset(){
  const password=document.getElementById("reset_pw").value;
  const err=document.getElementById("reset_err");
  if(password.length<8){ err.textContent="Use at least 8 characters."; return; }
  try{
    await store.updatePassword(password);
    await store.signOut();
    location.href=location.origin+"/";
  }catch(e){ err.textContent=e.message; }
}
export function enterDemo(){
  localStorage.setItem(DEMO_KEY,"1");
  load().then(()=>{ render(); handleLaunchAction(); toast("Demo mode — sample data, stored only on this device"); });
}
export function exitDemo(){
  localStorage.removeItem(DEMO_KEY);
  load().then(()=>{ render(); handleLaunchAction(); });
}
