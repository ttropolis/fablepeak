/* =============== storage adapters ===============
   All persistence flows through `store`. The UI never touches
   localStorage or a network directly — swapping in a real backend
   means implementing RemoteAdapter only. See BACKEND_SPEC.md. */
import { LS_KEY } from "./constants.js";

export const LocalAdapter = {
  name: "local",
  user: null,                                  // no auth in local mode
  async init(){},
  async load(){ try{ return JSON.parse(localStorage.getItem(LS_KEY)); }catch(e){ return null; } },
  async persist(data){ localStorage.setItem(LS_KEY, JSON.stringify(data)); },
  async signIn(){ throw new Error("Local mode has no accounts"); },
  async signUp(){ throw new Error("Local mode has no accounts"); },
  async signOut(){},
  /* Local and demo workspaces have no accounts, so there is nobody to share a
     brand with and nobody to be an editor of it: whoever holds the browser owns
     everything in it. Returning "owner" keeps every owner-gated affordance
     visible offline without the views having to special-case local mode. */
  async myRole(){ return "owner"; },
  onRemoteChange(cb){ /* no-op: nothing else writes local data */ },
};
