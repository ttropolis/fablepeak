/* =============== public landing page + auth gate (cloud mode, signed out) ===
   ADR 0008: "/" must be a complete marketing page for a signed-out visitor —
   TikTok App Review rejects a bare login screen. The sign-in / create-account
   card is the same .wcard as before, but it is not rendered until the visitor
   asks for it ("Sign in", "Create account", "Get started"). */
import { DEMO_KEY } from "./constants.js";
import { setWMode, wMode } from "./state.js";
import { store } from "./store.js";
import { load } from "./workspace.js";
import { handleLaunchAction, render, toast } from "./shell.js";

/* Is the auth panel revealed? Module-local because it is pure view state: it
   never survives leaving the gate, and hideWelcome() clears it. */
let authOpen = false;

const FEATURES = [
  ["🗓", "Plan on a calendar",
    "Drag posts around a month or week view, keep drafts and scheduled posts side by side, and see the whole plan for a brand at a glance."],
  ["📤", "Publish to your networks",
    "Connect Facebook Pages, Instagram and YouTube, then send one post to all of them — or schedule it and let FablePeak deliver it. TikTok is coming once its app review completes."],
  ["✍️", "Write once, tailor per network",
    "Save hashtag groups and reuse them, then override the caption, hashtags or media for any single network without duplicating the post."],
  ["✅", "Approvals for teams",
    "Editors submit, owners approve. Nothing reaches a connected account until someone with the right role says yes."],
  ["💬", "One inbox",
    "Comments and messages from your connected accounts arrive in a single list, so no network gets forgotten."],
  ["📈", "Analytics you can read",
    "Reach, engagement and per-post results in plain numbers, with a best-times heatmap built from your own history."],
  ["🔗", "SmartLinks link-in-bio",
    "Build a hosted link-in-bio page for each brand, and see which links people actually click."],
  ["📱", "Installs as an app",
    "FablePeak is a progressive web app: install it on your phone or desktop, and keep browsing your plan when the connection drops."],
];

const STEPS = [
  ["Connect your accounts",
    "Sign in with each network and pick the Page, profile or channel FablePeak may post to. You choose the scopes, and you can disconnect any account later."],
  ["Plan and compose",
    "Write the post once, attach media, apply a hashtag group, and adjust the copy per network where it matters. Team members can send it for approval."],
  ["Publish or schedule",
    "Send it now or put it on the calendar. Every attempt records a per-network result, so you can see what went out and what needs a retry."],
];

function featureCard([icon, title, body]){
  return `<li class="lfeat">
      <span class="lfi" aria-hidden="true">${icon}</span>
      <h3>${title}</h3>
      <p>${body}</p>
    </li>`;
}
function stepCard([title, body], i){
  return `<li class="lstep">
      <span class="lnum" aria-hidden="true">${i + 1}</span>
      <h3>${title}</h3>
      <p>${body}</p>
    </li>`;
}

function authPanel(){
  if(!authOpen) return "";
  return `
  <div class="lauthwrap" id="w_auth" data-action="closeAuth">
    <div class="wcard" role="dialog" aria-modal="true" tabindex="-1" aria-label="${wMode==='signin'?'Sign in to FablePeak':'Create a FablePeak account'}">
      <button type="button" class="lclose" data-action="closeAuth" aria-label="Close">✕</button>
      <div class="wtabs">
        <button class="${wMode==='signin'?'on':''}" data-action="wTab" data-arg="signin">Sign in</button>
        <button class="${wMode==='signup'?'on':''}" data-action="wTab" data-arg="signup">Create account</button>
      </div>
      <label class="f">Email</label>
      <input type="email" id="w_email" placeholder="you@example.com" autocomplete="email">
      <label class="f">Password</label>
      <div class="pwwrap">
        <input type="password" id="w_pw" placeholder="${wMode==='signup'?'Min 8 characters':'Your password'}"
          autocomplete="${wMode==='signup'?'new-password':'current-password'}"
          data-enter="wSubmit">
        <button type="button" class="pwtoggle" data-action="togglePassword" data-arg="w_pw" aria-label="Show password">👁</button>
      </div>
      <div class="werr" id="w_err"></div>
      <button class="btn wsubmit" data-action="wSubmit">${wMode==='signin'?'Sign in':'Create my account'}</button>
      ${wMode==='signin' ? `<button class="btn ghost wdemo" style="margin-top:8px" data-action="requestPasswordReset">Forgot password?</button>` : ""}
      <div class="wdivide">or</div>
      <button class="btn ghost wdemo" data-action="enterDemo">👀 Explore the demo</button>
      <div class="wfoot">FablePeak is in invite-only beta. The demo runs entirely in your browser with sample data — no account, nothing uploaded.<br>
        <a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · <a href="/data-deletion.html">Data deletion</a></div>
    </div>
  </div>`;
}

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
  <div class="lpage"${authOpen ? " inert" : ""}>
    <header class="lnav">
      <div class="wlogo"><span class="wlogo-mark" aria-hidden="true"></span> Fable<span>Peak</span></div>
      <div class="lnavact">
        <button class="btn ghost lghost" id="lp_signin" data-action="showAuth" data-arg="signin">Sign in</button>
        <button class="btn" data-action="showAuth" data-arg="signup">Get started</button>
      </div>
    </header>

    <section class="lhero" aria-labelledby="l_hero_h">
      <h1 id="l_hero_h">All your social media, one clean workspace.</h1>
      <p class="lead">FablePeak is a social media manager for small brands and the people who
        help them: plan a content calendar, compose a post once and tailor it per network,
        publish or schedule to Facebook Pages, Instagram and YouTube — with TikTok coming once
        its app review completes — answer messages
        in one inbox, watch what worked, and hand out a link-in-bio page — without juggling ten tabs.</p>
      <div class="lcta">
        <button class="btn lbig" data-action="showAuth" data-arg="signup">Get started</button>
        <button class="btn ghost lbig lghost" data-action="enterDemo">Explore the demo</button>
      </div>
      <p class="lnote">Invite-only beta</p>
    </section>

    <section class="lsec" aria-labelledby="l_feat_h">
      <h2 id="l_feat_h">What you can do</h2>
      <ul class="lgrid">${FEATURES.map(featureCard).join("")}</ul>
    </section>

    <section class="lsec" aria-labelledby="l_how_h">
      <h2 id="l_how_h">How it works</h2>
      <ol class="lsteps">${STEPS.map(stepCard).join("")}</ol>
    </section>

    <section class="lsec" aria-labelledby="l_team_h">
      <h2 id="l_team_h">Built for small brands and teams</h2>
      <p class="lbody">A workspace has owners and editors. Owners connect accounts, invite
        teammates and approve work; editors plan, write and submit.
        Turn the approval workflow on for a brand and every post waits for an owner's yes
        before it can be published or scheduled — so a freelancer or junior teammate can
        work in the real calendar without anyone worrying about what reaches the audience.</p>
    </section>

    <section class="lsec" aria-labelledby="l_priv_h">
      <h2 id="l_priv_h">Privacy by design</h2>
      <p class="lbody">FablePeak asks each network only for the permissions it needs to
        publish and report on the accounts you pick. Access tokens are encrypted before they
        are stored on our server and are never exposed to the browser. You can disconnect a
        single account, or delete your whole workspace and everything in it, at any time.</p>
      <p class="lbody"><a href="/privacy.html">Privacy policy</a> ·
        <a href="/terms.html">Terms of service</a> ·
        <a href="/data-deletion.html">Data deletion</a></p>
    </section>

    <section class="lsec lbeta" aria-labelledby="l_beta_h">
      <h2 id="l_beta_h">Join the invite-only beta</h2>
      <p class="lbody">FablePeak is open to a small group of brands and agencies while we
        finish the remaining network integrations. Create an account to join the list, or
        write to us and tell us what you publish.</p>
      <div class="lcta">
        <button class="btn lbig" data-action="showAuth" data-arg="signup">Get started</button>
        <a class="lmail" href="mailto:fablepeak@techpolity.com">fablepeak@techpolity.com</a>
      </div>
    </section>

    <footer class="lfoot">
      <div class="wlogo"><span class="wlogo-mark" aria-hidden="true"></span> Fable<span>Peak</span></div>
      <p>© Techpolity. All rights reserved.</p>
      <p><a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> ·
        <a href="/data-deletion.html">Data deletion</a></p>
    </footer>
  </div>
  ${authPanel()}`;
  if(authOpen){
    // The card is a modal dialog: move focus into it on every render, so a
    // keyboard or screen-reader user is not left behind the inert landing page.
    w.querySelector(".wcard")?.focus();
    // Avoid covering the form with the software keyboard on phones.
    if(window.matchMedia("(min-width: 821px)").matches)
      document.getElementById("w_email").focus();
  }
}
export function hideWelcome(){
  const w=document.getElementById("welcome");
  w.hidden=true; w.innerHTML=""; authOpen=false;
  document.querySelector("aside").inert = false;
  document.getElementById("main").inert = false;
}
/* Reveal the auth card on the landing page, on the chosen tab. */
export function showAuth(m){ authOpen=true; setWMode(m==="signup"?"signup":"signin"); showWelcome(); }
export function closeAuth(){
  authOpen=false; showWelcome();
  // Return focus to the control that opened the dialog, not to <body>.
  document.getElementById("lp_signin")?.focus();
}
export function wTab(m){ setWMode(m); showWelcome(); }

/* Reveal toggle, shared by the sign-in card and the reset card. The button is
   the input's own sibling inside .pwwrap, so it is found from the input rather
   than from an id of its own. */
export function togglePassword(id){
  const input=document.getElementById(id);
  if(!input) return;
  const shown = input.type === "text";
  input.type = shown ? "password" : "text";
  const toggle = input.parentElement?.querySelector("button");
  if(!toggle) return;
  toggle.textContent = shown ? "👁" : "🙈";
  toggle.setAttribute("aria-label", shown ? "Show password" : "Hide password");
}
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
  authOpen=false;
  document.querySelector("aside").inert = true;
  document.getElementById("main").inert = true;
  w.hidden=false;
  w.innerHTML=`<div class="wwrap"><div class="wcard" style="max-width:440px;margin:auto">
    <div class="wlogo"><span class="wlogo-mark" aria-hidden="true"></span> Fable<span>Peak</span></div>
    <h2 style="margin:20px 0 6px">Choose a new password</h2>
    <p class="wsmall">Use at least 8 characters.</p>
    <label class="f">New password</label>
    <div class="pwwrap">
      <input type="password" id="reset_pw" autocomplete="new-password" placeholder="Min 8 characters"
        data-enter="completePasswordReset">
      <button type="button" class="pwtoggle" data-action="togglePassword" data-arg="reset_pw" aria-label="Show password">👁</button>
    </div>
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
