/* Cloud backend — Supabase implementation of the adapter contract
   (BACKEND_SPEC.md §4). Active only when backend-config.js defines
   window.FABLEPEAK_BACKEND. Signed-out visitors degrade to local mode.

   The Supabase SDK is imported dynamically, from a pinned esm.sh URL, on the
   cloud path only: a local/demo workspace never reaches the network at all. */
import { LS_KEY } from "./constants.js";
import { mediaContentType, uid } from "./util.js";
import { showPasswordReset } from "./welcome.js";

export const RemoteAdapter = {
  name: "cloud",
  user: null,
  _sb: null,
  _clientId: null,
  _snap: null,          // last-synced server state, for diffing in persist()

  async init(){
    if(this._sb) return; // load() is reused after auth/demo transitions
    const cfg = window.FABLEPEAK_BACKEND;
    try{
      // Pin the browser dependency so a future CDN release cannot change the
      // production app without a reviewed FablePeak deployment.
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.112.0");
      this._sb = createClient(cfg.url, cfg.anonKey);
      this._clientId = sessionStorage.getItem("fp_client") ||
        (sessionStorage.setItem("fp_client", uid()), sessionStorage.getItem("fp_client"));
      const { data:{ session } } = await this._sb.auth.getSession();
      if(session) this.user = { id: session.user.id, email: session.user.email };
      this._sb.auth.onAuthStateChange((event, session) => {
        if(session?.user) this.user = { id:session.user.id, email:session.user.email };
        else if(event === "SIGNED_OUT") this.user = null;
        if(event === "PASSWORD_RECOVERY") queueMicrotask(showPasswordReset);
      });
    }catch(e){ this._sb=null; throw e; }
  },

  _rowsToDb(brands, posts, inbox, targets=[]){
    const mappedBrands = brands.map(b => ({
        id: b.id, name: b.name, seed: b.seed,
        connections: b.connections || {}, smartlink: b.smartlink || {},
        posts: posts.filter(p => p.brand_id===b.id).map(p => ({
          id: p.id, date: p.date, time: p.time, text: p.text,
          networks: p.networks || [], status: p.status, media_url: p.media_url || "",
          targets: targets.filter(t => t.post_id===p.id) })),
        inbox: inbox.filter(t => t.brand_id===b.id).map(t => ({
          id: t.id, net: t.net, from: t.sender, resolved: t.resolved,
          unread: t.unread, msgs: t.msgs || [] })),
      }));
    const preferredBrand = localStorage.getItem("fablepeak_pref_activeBrand") || "";
    return {
      brands: mappedBrands,
      activeBrand: mappedBrands.some(b => b.id===preferredBrand)
        ? preferredBrand : (mappedBrands[0]?.id || ""),
    };
  },
  _dbToRows(data){
    const brands=[], posts=[], inbox=[];
    for(const b of data.brands){
      brands.push({ id:b.id, name:b.name, seed:b.seed,
        connections:b.connections||{}, smartlink:b.smartlink||{}, client_id:this._clientId });
      for(const p of b.posts) posts.push({ id:p.id, brand_id:b.id, date:p.date,
        time:p.time||"10:00", text:p.text, networks:p.networks||[], status:p.status,
        media_url:p.media_url || null, client_id:this._clientId });
      for(const t of b.inbox) inbox.push({ id:t.id, brand_id:b.id, net:t.net,
        sender:t.from, resolved:!!t.resolved, unread:!!t.unread, msgs:t.msgs||[],
        client_id:this._clientId });
    }
    return { brands, posts, inbox };
  },

  async load(){
    if(!this.user) return null;                 // logged out → local fallback
    try{
      const [brandsResult, postsResult, inboxResult, targetsResult] = await Promise.all([
        this._sb.from("brands").select("*"),
        this._sb.from("posts").select("*"),
        this._sb.from("inbox_threads").select("*"),
        this._sb.from("post_targets").select("*"),
      ]);
      const queryError=brandsResult.error||postsResult.error||inboxResult.error||targetsResult.error;
      if(queryError) throw queryError;
      // first sign-in with an empty server: offer to upload existing local data
      if(!brandsResult.data.length){
        let local=null; try{ local=JSON.parse(localStorage.getItem(LS_KEY)); }catch(e){}
        if(local && local.brands?.length &&
           confirm("Your cloud workspace is empty. Upload this device's existing data to it?")){
          this._snap = {brands:[],posts:[],inbox:[]};
          await this.persist(local);
          return local;
        }
      }
      this._snap = {
        brands:brandsResult.data, posts:postsResult.data, inbox:inboxResult.data,
      };
      const db = this._rowsToDb(
        brandsResult.data, postsResult.data, inboxResult.data, targetsResult.data,
      );
      if(!db.activeBrand && db.brands.length) db.activeBrand = db.brands[0].id;
      localStorage.setItem(LS_KEY, JSON.stringify(db));   // offline cache
      return db.brands.length ? db : null;
    }catch(e){                                  // offline → serve cache
      try{ return JSON.parse(localStorage.getItem(LS_KEY)); }catch(_){ return null; }
    }
  },

  async persist(data){
    localStorage.setItem("fablepeak_pref_activeBrand", data.activeBrand || "");
    localStorage.setItem(LS_KEY, JSON.stringify(data));   // cache first — never lose edits
    if(!this.user) return;
    const cur = this._dbToRows(data), prev = this._snap || {brands:[],posts:[],inbox:[]};
    const FIELDS = {
      brands: ["id","name","seed","connections","smartlink"],
      posts:  ["id","brand_id","date","time","text","networks","status","media_url"],
      inbox:  ["id","brand_id","net","sender","resolved","unread","msgs"],
    };
    const norm = (r, fs) => JSON.stringify(fs.map(f => r[f] ?? null));
    const changed = (rows, old, fs) => rows.filter(r => {
      const o = old.find(x => x.id === r.id);
      return !o || norm(r, fs) !== norm(o, fs);
    });
    const gone = (rows, old) => old.filter(o => !rows.some(r=>r.id===o.id)).map(o=>o.id);
    const fail = r => { if(r && r.error) throw new Error(r.error.message); };
    // brands first (posts/inbox reference them), via the RPC so ownership is created too
    const cb = changed(cur.brands, prev.brands, FIELDS.brands);
    for(const row of cb){
      const b = data.brands.find(x => x.id === row.id);
      if(b) await this._saveBrand(b);
    }
    const ops = [];
    const cp = changed(cur.posts, prev.posts, FIELDS.posts);  if(cp.length) ops.push(this._sb.from("posts").upsert(cp));
    const ct = changed(cur.inbox, prev.inbox, FIELDS.inbox);  if(ct.length) ops.push(this._sb.from("inbox_threads").upsert(ct));
    const gp = gone(cur.posts, prev.posts);   if(gp.length) ops.push(this._sb.from("posts").delete().in("id", gp));
    const gt = gone(cur.inbox, prev.inbox);   if(gt.length) ops.push(this._sb.from("inbox_threads").delete().in("id", gt));
    const gb = gone(cur.brands, prev.brands); if(gb.length) ops.push(this._sb.from("brands").delete().in("id", gb));
    (await Promise.all(ops)).forEach(fail);
    this._snap = { brands:cur.brands, posts:cur.posts, inbox:cur.inbox };
  },

  async signIn(email, password){
    const { data, error } = await this._sb.auth.signInWithPassword({ email, password });
    if(error) throw new Error(error.message);
    this.user = { id: data.user.id, email: data.user.email };
  },
  async signUp(email, password){
    const { data, error } = await this._sb.auth.signUp({ email, password });
    if(error) throw new Error(error.message);
    if(data.session){ this.user = { id: data.user.id, email: data.user.email }; return "active"; }
    return "confirm-email";                     // confirmation link sent
  },
  async signOut(){
    await this._sb.auth.signOut();
    this.user = null;
  },
  async sendPasswordReset(email){
    const { error } = await this._sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + "/",
    });
    if(error) throw new Error(error.message);
  },
  async updatePassword(password){
    const { error } = await this._sb.auth.updateUser({ password });
    if(error) throw new Error(error.message);
  },
  async uploadMedia(file, brandId, onProgress=()=>{}){
    if(!this.user) throw new Error("Sign in before uploading media.");
    const contentType=mediaContentType(file);
    if(!contentType) throw new Error("Use JPEG, PNG, WebP, GIF, MP4, MOV or WebM media.");
    const ext=(file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,8) || "bin";
    const path=`${brandId}/${crypto.randomUUID()}.${ext}`;
    if(file.size<=6*1024*1024){
      const { data, error } = await this._sb.storage.from("social-media").upload(path, file, {
        cacheControl:"31536000", contentType, upsert:false,
      });
      if(error) throw new Error(error.message);
      onProgress(100);
      const { data:publicData } = this._sb.storage.from("social-media").getPublicUrl(data.path);
      if(!publicData?.publicUrl) throw new Error("Upload completed but no media URL was returned.");
      return publicData.publicUrl;
    }

    // Supabase recommends TUS for files above 6 MB and unstable networks. It
    // retries 6 MB chunks instead of restarting an entire phone video.
    const jwt=await this._jwt();
    if(!jwt) throw new Error("Sign in again before uploading media.");
    const projectId=new URL(window.FABLEPEAK_BACKEND.url).hostname.split(".")[0];
    const { Upload } = await import("https://esm.sh/tus-js-client@4.3.1");
    await new Promise((resolve,reject)=>{
      const upload=new Upload(file,{
        endpoint:`https://${projectId}.storage.supabase.co/storage/v1/upload/resumable`,
        retryDelays:[0,3000,5000,10000,20000],
        headers:{authorization:`Bearer ${jwt}`,apikey:window.FABLEPEAK_BACKEND.anonKey},
        uploadDataDuringCreation:true,
        removeFingerprintOnSuccess:true,
        chunkSize:6*1024*1024,
        metadata:{bucketName:"social-media",objectName:path,contentType,cacheControl:"31536000"},
        onError:error=>reject(error),
        onProgress:(sent,total)=>onProgress(total ? Math.round(sent/total*100) : 0),
        onSuccess:()=>resolve(),
      });
      upload.start();
    });
    const { data:publicData } = this._sb.storage.from("social-media").getPublicUrl(path);
    if(!publicData?.publicUrl) throw new Error("Upload completed but no media URL was returned.");
    return publicData.publicUrl;
  },

  /* ---------- real platform connections (Edge Functions) ---------- */
  get _fnBase(){ return window.FABLEPEAK_BACKEND.url + "/functions/v1"; },
  async _jwt(){
    const { data:{ session } } = await this._sb.auth.getSession();
    return session?.access_token;
  },
  /** platforms whose OAuth credentials are configured on the server */
  async availablePlatforms(){
    try{
      const r = await fetch(`${this._fnBase}/oauth-start?action=available`,
        { headers:{ apikey: window.FABLEPEAK_BACKEND.anonKey } });
      if(!r.ok) return [];
      return (await r.json()).platforms || [];
    }catch(e){ return []; }
  },
  /** connected accounts for a brand — token-free view */
  async listAccounts(brandId){
    if(!this.user) return [];
    const { data, error } = await this._sb.from("social_accounts_public")
      .select("*").eq("brand_id", brandId);
    if(error) return [];
    return data || [];
  },
  /** Guarantee the brand row exists server-side before anything references it.
      Local-only brands (created before sign-in, or after a failed save) would
      otherwise make the server reject the connection with "no access". */
  /** Create/update a brand via the save_brand RPC.
      A plain upsert cannot work here: RLS needs you to own the brand, but
      ownership only exists once the row is created. save_brand does both
      atomically, server-side. */
  async _saveBrand(b){
    const { error } = await this._sb.rpc("save_brand", {
      p_id: b.id, p_name: b.name, p_seed: b.seed ?? 0,
      p_connections: b.connections || {}, p_smartlink: b.smartlink || {},
    });
    if(error) throw new Error(error.message);
  },
  async ensureBrandSynced(b){
    if(!this.user) throw new Error("Sign in first — your session may have expired.");
    try{ await this._saveBrand(b); }
    catch(e){ throw new Error("Could not save this brand to the cloud: " + e.message); }
    const { data: mem } = await this._sb.from("brand_members")
      .select("brand_id").eq("brand_id", b.id).maybeSingle();
    if(!mem) throw new Error(
      "This brand isn't linked to your account yet. Sign out and back in, then retry.");
  },

  /** The caller's own role in one brand — "owner", "editor", or null when the
      row cannot be read. The cheapest honest source there is: `members_select`
      already lets every member read their own brand_members row, so this is one
      primary-key lookup and no new backend surface. Filtering on user_id as
      well as brand_id keeps it to a single row in a shared workspace.
      The role decides which controls are *offered*; ADR 0006 puts the actual
      enforcement in RLS, triggers and the definer RPCs, never here. */
  async myRole(brandId){
    if(!this.user) return null;
    const { data, error } = await this._sb.from("brand_members")
      .select("role").eq("brand_id", brandId).eq("user_id", this.user.id).maybeSingle();
    if(error) return null;
    return data?.role || null;
  },
  /* ---------- team invitations (ADR 0006 delivery item 2) ----------
     Seven calls, six of them PostgREST RPCs over security-definer functions in
     20260830110000_team_invitations.sql, exposed exactly the way get_smartlink
     and set_smartlink_slug are. There is no Edge Function and no mail provider:
     an invite is a row, and the invitee claims it once their own confirmed
     address matches. Every refusal that is a *result* rather than a breach
     comes back as {ok:false,error:"…"} for the caller to render. */

  /** The active brand's roster: [{member_id, member_email, member_role}].
      brand_member_list is member-gated, so an editor sees it too — that is
      decision 12, and it is why bare UUIDs are not what the Team card shows. */
  async listMembers(brandId){
    if(!this.user) return [];
    const { data, error } = await this._sb.rpc("brand_member_list", { p_brand_id: brandId });
    if(error) throw new Error(error.message);
    return data || [];
  },
  /** Pending invitations for one brand, newest last. A plain select: the
      invites_select policy is is_owner(brand_id), so an editor gets [] from the
      database rather than from a render gate. */
  async listInvites(brandId){
    if(!this.user) return [];
    const { data, error } = await this._sb.from("brand_invites")
      .select("id,email,role,status,created_at,expires_at")
      .eq("brand_id", brandId).eq("status", "pending").order("created_at");
    if(error) throw new Error(error.message);
    return data || [];
  },
  /** Owner-only. Returns the typed jsonb result — {ok:true,invite_id,email,role}
      or {ok:false,error:"already_member"|"already_invited"|"invalid_email"|
      "invalid_role"|"self_invite"}. Only a non-owner call raises. */
  async inviteMember(brandId, email, role){
    const { data, error } = await this._sb.rpc("create_invite",
      { p_brand_id: brandId, p_email: email, p_role: role });
    if(error) throw new Error(error.message);
    return data || { ok:false, error:"unknown_error" };
  },
  /** Owner-only. Retains the row as status='revoked' — the one revocation model
      this feature has; nothing ever deletes a brand_invites row. */
  async revokeInvite(inviteId){
    const { data, error } = await this._sb.rpc("revoke_invite", { p_invite_id: inviteId });
    if(error) throw new Error(error.message);
    return data || { ok:false, error:"unknown_error" };
  },
  /** Invitations addressed to this signed-in user's own CONFIRMED address:
      [{invite_id, brand_name, invite_role, invited_at, expires_at}]. There is
      deliberately no brand_id in that shape — until Accept, an invitee holds a
      workspace's display name and nothing that any RLS policy is written on. */
  async myInvitations(){
    if(!this.user) return [];
    const { data, error } = await this._sb.rpc("list_my_invites");
    if(error) throw new Error(error.message);
    return data || [];
  },
  /** Join. The server re-checks the confirmed-email match, the pending status
      and the expiry — this is an explicit act by the invitee, never a silent
      auto-join (decision 4). */
  async acceptInvite(inviteId){
    const { data, error } = await this._sb.rpc("accept_invite", { p_invite_id: inviteId });
    if(error) throw new Error(error.message);
    return data || { ok:false, error:"unknown_error" };
  },
  async declineInvite(inviteId){
    const { data, error } = await this._sb.rpc("decline_invite", { p_invite_id: inviteId });
    if(error) throw new Error(error.message);
    return data || { ok:false, error:"unknown_error" };
  },
  /** opens the platform's consent screen; resolves when the popup reports back */
  async startOAuth(platform, brandId){
    const jwt = await this._jwt();
    if(!jwt) throw new Error("Sign in first");
    // open synchronously so the browser doesn't treat it as a blocked popup
    const popup = window.open("about:blank", "fablepeak_oauth", "width=600,height=760");
    const r = await fetch(`${this._fnBase}/oauth-start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, apikey: window.FABLEPEAK_BACKEND.anonKey,
                 "Content-Type": "application/json" },
      body: JSON.stringify({ platform, brand_id: brandId }),
    });
    const out = await r.json();
    if(!r.ok){ popup?.close(); throw new Error(out.error || "Could not start connection"); }
    if(popup) popup.location = out.url; else window.location = out.url;
    return new Promise(resolve => {
      const done = (ok) => { window.removeEventListener("message", onMsg); clearInterval(poll); resolve(ok); };
      const onMsg = (e) => {
        if(e.origin !== location.origin || e.source !== popup) return;
        if(e.data?.source === "fablepeak-oauth") done(!!e.data.ok);
      };
      window.addEventListener("message", onMsg);
      const poll = setInterval(() => { if(popup?.closed) done(true); }, 800);
    });
  },
  /** ask the provider to drop its authorization; best effort by design, so a
   * provider outage never stops the local disconnect below */
  async revokeAccount(id, brandId){
    const jwt = await this._jwt();
    if(!jwt || !brandId) return;
    await fetch(`${this._fnBase}/connection-health`, {
      method:"POST",
      headers:{ Authorization:`Bearer ${jwt}`, apikey:window.FABLEPEAK_BACKEND.anonKey,
                "Content-Type":"application/json" },
      body:JSON.stringify({ brand_id:brandId, account_id:id, action:"revoke" }),
    });
  },
  async disconnectAccount(id, brandId){
    await this.revokeAccount(id, brandId).catch(()=>{});
    const { error } = await this._sb.rpc("disconnect_account", { account_id: id });
    if(error) throw new Error(error.message);
  },
  async selectAccount(id){
    const { data, error } = await this._sb.rpc("select_social_account", { account_id: id });
    if(error) throw new Error(error.message);
    if(!data) throw new Error("That account is no longer available. Refresh and try again.");
  },
  async verifyAccounts(brandId){
    const jwt = await this._jwt();
    if(!jwt) throw new Error("Sign in first");
    const r = await fetch(`${this._fnBase}/connection-health`, {
      method:"POST",
      headers:{ Authorization:`Bearer ${jwt}`, apikey:window.FABLEPEAK_BACKEND.anonKey,
                "Content-Type":"application/json" },
      body:JSON.stringify({ brand_id:brandId }),
    });
    const out = await r.json();
    if(!r.ok) throw new Error(out.error || "Could not verify connections");
    return out.results || [];
  },
  async deleteAccount(password){
    const jwt=await this._jwt();
    if(!jwt) throw new Error("Sign in first");
    const r=await fetch(`${this._fnBase}/delete-account`,{
      method:"POST",
      headers:{Authorization:`Bearer ${jwt}`,apikey:window.FABLEPEAK_BACKEND.anonKey,
               "Content-Type":"application/json"},
      body:JSON.stringify({confirm:"DELETE",password}),
    });
    const out=await r.json();
    if(!r.ok) throw new Error(out.error||"Could not delete account");
  },
  /** publish a post to its platforms right now */
  async _publishRequest(postId,retry=false){
    const jwt = await this._jwt();
    const r = await fetch(`${this._fnBase}/publish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, apikey: window.FABLEPEAK_BACKEND.anonKey,
                 "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: postId, ...(retry?{retry:true}:{}) }),
    });
    const out = await r.json();
    if(!r.ok) throw new Error(out.error || (retry?"Retry failed":"Publish failed"));
    return out.results || [];
  },
  async publishNow(postId){ return this._publishRequest(postId); },
  async retryPost(postId){ return this._publishRequest(postId,true); },
  /** Composer writing assist (supabase/functions/ai-assist).
      `request` is the function's own body minus brand_id and tier:
      {action:"caption", topic, tone?, network?} | {action:"hashtags", text,
      network?} | {action:"rewrite", text, network}. Resolves to {suggestions,
      truncated}.
      The capability tier is sent explicitly rather than left to the server's
      default, so the day a picker ships the only change is where the value
      comes from. "standard" is the only tier any plan includes today; asking
      for another one is a 403 from the function.
      A failure throws an Error carrying only the function's already
      customer-facing message plus `status` and, for a rate limit,
      `retryAfterSeconds` — the response body itself is never shown. */
  async aiAssist(brandId, request){
    const jwt = await this._jwt();
    if(!jwt) throw new Error("Sign in first");
    const r = await fetch(`${this._fnBase}/ai-assist`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, apikey: window.FABLEPEAK_BACKEND.anonKey,
                 "Content-Type": "application/json" },
      body: JSON.stringify({ brand_id: brandId, tier: "standard", ...request }),
    });
    const out = await r.json().catch(() => ({}));
    if(!r.ok){
      const failure = new Error(String(out.error || "AI assist could not answer. Try again shortly."));
      failure.status = r.status;
      const retry = Number(out.retry_after_seconds);
      if(Number.isFinite(retry) && retry > 0) failure.retryAfterSeconds = retry;
      throw failure;
    }
    return { suggestions: out.suggestions || [], truncated: !!out.truncated };
  },
  /** per-platform delivery records for this brand's posts */
  async listTargets(brandId){
    if(!this.user) return [];
    const { data } = await this._sb.from("post_targets").select("*").eq("brand_id", brandId);
    return data || [];
  },
  /* ---------- public SmartLinks (ADR 0004) ---------- */
  /** the brand's claimed slug and whether its page is published */
  async smartlinkPublishing(brandId){
    if(!this.user) return { slug:"", published:false };
    const { data, error } = await this._sb.from("brands")
      .select("smartlink_slug,smartlink_public").eq("id", brandId).maybeSingle();
    if(error) throw new Error(error.message);
    return { slug: data?.smartlink_slug || "", published: !!data?.smartlink_public };
  },
  /** Claim or rename the public slug. Returns the RPC's typed jsonb result
      ({ok:true,slug,changed} | {ok:false,error}) — a taken name is a result,
      not an exception. Writing brands.smartlink_slug directly is refused by the
      brands_guard_smartlink_slug trigger, so this RPC is the only way in.
      Owner-only since ADR 0006: an editor's call raises 42501. */
  async setSmartlinkSlug(brandId, slug){
    const { data, error } = await this._sb.rpc("set_smartlink_slug",
      { p_brand_id: brandId, p_slug: slug });
    if(error) throw new Error(error.message);
    return data || { ok:false, error:"unknown_error" };
  },
  /** Publish / unpublish. A plain UPDATE under the member-level brands_update
      policy, but brands_guard_smartlink_slug refuses a change to this column
      from anyone who is not an owner (ADR 0006): RLS is row-level and cannot
      express a column rule, so the trigger is where that lives. */
  async setSmartlinkPublic(brandId, isPublic){
    const { error } = await this._sb.from("brands")
      .update({ smartlink_public: !!isPublic }).eq("id", brandId);
    if(error) throw new Error(error.message);
  },
  /** Member-only click aggregates. Approximate by construction — no cookies,
      IPs or device identifiers are collected, so the UI must say so. */
  async smartlinkClickTotals(brandId){
    if(!this.user) return [];
    const { data, error } = await this._sb.from("smartlink_click_totals")
      .select("link_id,total,last_7d").eq("brand_id", brandId);
    if(error) throw new Error(error.message);
    return data || [];
  },
  /** real metrics, when the ingest job has run */
  async listMetrics(brandId, days=30){
    if(!this.user) return [];
    const from = new Date(Date.now() - days*864e5).toISOString().slice(0,10);
    const { data, error } = await this._sb.from("metrics_daily")
      .select("*").eq("brand_id", brandId).gte("date", from).order("date");
    if(error) throw new Error(error.message);
    return data || [];
  },

  onRemoteChange(cb){
    if(!this._sb || !this.user || this._subscribed) return;
    this._subscribed = true;
    let t = null;
    this._sb.channel("fablepeak-sync")
      .on("postgres_changes", { event:"*", schema:"public" }, payload => {
        if(payload.new && payload.new.client_id === this._clientId) return;  // own echo
        clearTimeout(t);
        t = setTimeout(async () => { const fresh = await this.load(); if(fresh) cb(fresh); }, 600);
      })
      .subscribe();
  },
};
