/* The escapers (ADR 0003 §2a). Every ${} that reaches rendered markup goes
   through exactly one of these, chosen by the context it lands in. Keeping them
   in one leaf module — imported by every renderer, importing nothing itself —
   is what makes "did this call site escape?" answerable by reading one file. */

/** HTML text-node escaper. */
export function esc(s){ return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

/* Attribute-context escaper (ADR 0003 §2a). esc() is the right escaper for a
   text node; inside an attribute value the set of characters that can end the
   value or start a second attribute is wider, so every ${} that lands in
   attribute position goes through attr() instead. Entity-encoding is decoded
   by the parser, so the attribute still reads back verbatim. */
export function attr(s){ return String(s??"").replace(/[&<>"'`=\s]/g,c=>"&#"+c.charCodeAt(0)+";"); }

// Navigation/media URLs must be absolute http(s) — blocks javascript: and data: schemes.
export function safeUrl(s){ try{ const u=new URL(String(s??"")); return (u.protocol==="https:"||u.protocol==="http:")?u.href:""; }catch{ return ""; } }

/* The SmartLink button colour is interpolated into style="" and value="". The
   colour input cannot produce anything but #rrggbb — importData and a tampered
   local cache can. Validated at render and again wherever it is written. */
export const DEFAULT_SL_COLOR = "#22c1dc";
export function slColorOf(value){
  return /^#[0-9a-f]{6}$/i.test(String(value??"")) ? String(value) : DEFAULT_SL_COLOR;
}
