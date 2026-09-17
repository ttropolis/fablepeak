/* Post templates — the shared vocabulary (ADR 0009).
 *
 * A template is a named, reusable post skeleton belonging to one brand:
 * `{ id, name, body }`, where the body carries `{slot}` placeholders:
 *
 *     🎙️ New episode {number}: {title}
 *
 *     {hook}
 *
 *     👉 Listen: {link}
 *
 * Settings creates and edits them; the composer picks one and asks the AI to
 * fit the post into it; Settings' backup importer checks a file's templates
 * against the same rules. Three call sites, one set of limits — so they live in
 * a leaf module that imports nothing, the way js/escape.js and js/hashtags.js
 * do, rather than being restated in each.
 *
 * The limits below are the same ones `valid_post_template_body` enforces in
 * 20260917090000_post_templates.sql, and TEMPLATE_BODY_MAX is also
 * MAX_TEMPLATE_CHARS in supabase/functions/ai-assist/index.ts. The database is
 * the last line, not the first: a rule stated only here would be a rule a
 * replayed backup or a psql session could walk past, and a rule stated only
 * there would reach the customer as a raw Postgres constraint name.
 */

export const TEMPLATE_NAME_MAX = 60;
export const TEMPLATE_BODY_MIN = 1;
export const TEMPLATE_BODY_MAX = 2000;
export const TEMPLATE_SLOTS_MIN = 1;
export const TEMPLATE_SLOTS_MAX = 20;
export const SLOT_NAME_MAX = 40;

/* The one spelling of a placeholder, mirrored character for character from the
   migration's `\{[A-Za-z0-9_]{1,40}\}`. Anything else is not a placeholder and
   is never treated as one: `{}`, `{first name}` and a lone `{` are ordinary
   characters the fill step reproduces verbatim, which is why a customer who
   writes `{first name}` is told their template has no slots rather than handed
   a slot whose name is a space.

   Declared with /g because matchAll requires it, and only ever used with
   matchAll — which clones the regex rather than advancing this one's lastIndex.
   A /g regex shared across .test() calls is stateful, and this module has no
   .test() call on it for exactly that reason. */
const PLACEHOLDER = /\{[A-Za-z0-9_]{1,40}\}/g;

/* A body is multi-line by nature — the line breaks *are* the shape — so unlike
   a hashtag it cannot refuse the whole C0 range. It refuses the rest of it:
   this is `[[:cntrl:]]` minus tab (\u0009) and newline (\u000A), the same
   exception translate() carves out in the CHECK. Carriage return is refused on
   purpose: a textarea's value normalises CRLF to LF, and two spellings of a
   line break would be two templates that look identical and produce different
   output.

   C1 (\u0080-\u009F) is in the range too, because Postgres' `[[:cntrl:]]`
   classifies it as control in a UTF-8 lc_ctype. A class that stopped at DEL
   would accept a body the CHECK then refuses, so the customer would get a raw
   constraint name at the next persistNow() instead of a sentence here — the
   exact failure this mirroring exists to prevent. It is also simply right: a C1
   character is never legitimate text, it is what a Windows-1252 mis-decode
   leaves behind. U+00A0, the next code point up, is ordinary typography and is
   deliberately not touched. */
const BODY_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
/* A *name* has no line breaks to protect: it comes from an <input type="text">,
   which cannot contain a newline or a tab. So the whole C0 range is refused
   there, the way a hashtag refuses it. This is deliberately stricter than the
   `char_length(name)` CHECK, which only bounds the length — the database is the
   last line, not the first, and it has nothing to say about what renders. */
const NAME_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/* Length in *characters*, the unit Postgres `char_length()` counts.
   JavaScript's `.length` counts UTF-16 code units, so an emoji is one character
   there and two here, and a template of 1500 emoji would be stored happily by
   the database and refused by this module. This feature is emoji-heavy by
   design — the seeded templates open with one — so that is not a corner case.
   "The same number as the CHECK" has to mean the same unit, and `[...s]`
   iterates code points, which is that unit. */
export function charLength(s){
  return [...String(s ?? "")].length;
}

/** The slot names this body carries, in the order they appear, *including
    duplicates* — a body that says `{title}` twice returns ["title","title"].
    That is deliberate and it is the number the CHECK counts: occurrences are
    what the model substitutes and what the customer sees as holes, so Settings'
    sentence and the constraint agree on one number rather than on two that
    match until somebody repeats a slot. Braces stripped, because the name is
    what a caller wants to show. */
export function parsePlaceholders(body){
  return [...String(body ?? "").matchAll(PLACEHOLDER)].map(m => m[0].slice(1, -1));
}

/** Is this a storable body? Mirrors valid_post_template_body(). */
export function validTemplateBody(body){
  if(typeof body !== "string") return false;
  const length = charLength(body);
  if(length < TEMPLATE_BODY_MIN || length > TEMPLATE_BODY_MAX) return false;
  if(BODY_CONTROL.test(body)) return false;
  const slots = parsePlaceholders(body).length;
  return slots >= TEMPLATE_SLOTS_MIN && slots <= TEMPLATE_SLOTS_MAX;
}

/** Is this a storable template? The shape the sync writes and a backup carries.
 *
 *  The name is held to what the UI can actually produce, not merely to what the
 *  column would accept: a trimmed non-empty name, of at most TEMPLATE_NAME_MAX
 *  characters, carrying no control character. Settings stores `name.trim()` and
 *  refuses an empty one, so a backup carrying "   " describes a template this
 *  app could never have made — and it renders as a nameless row with an Edit
 *  button beside it. An imported file is as untrusted as any other input. */
export function validTemplate(t){
  return !!t && typeof t === "object" && !Array.isArray(t)
    && typeof t.id === "string" && t.id.length > 0 && t.id.length <= 200
    && typeof t.name === "string"
    && t.name.trim().length >= 1 && charLength(t.name) <= TEMPLATE_NAME_MAX
    && !NAME_CONTROL.test(t.name)
    && validTemplateBody(t.body);
}

/** One brand's templates, always an array — a brand created before this feature
    simply has none, which is not an error. */
export function templatesOf(b){
  return Array.isArray(b?.post_templates) ? b.post_templates : [];
}

/* What the customer types in the Settings textarea, made storable.
   The only repair is the line ending: a paste from a Windows editor or a
   CRLF-delimited file carries \r\n, the CHECK refuses \r, and "your template
   contains a control character" is not a sentence anybody can act on. Every
   other character is left exactly as it was typed — trimming, collapsing or
   normalising anything else would break the one promise this feature makes,
   which is that what is outside the slots comes back byte for byte. */
export function normalizeTemplateBody(input){
  return String(input ?? "").replace(/\r\n?/g, "\n");
}

/** Why this name and body cannot be saved, as a sentence — or "" when they
    can. One message at a time, in the order the customer meets the fields. */
export function describeTemplateProblem(name, body){
  const clean = String(name ?? "").trim();
  if(!clean) return "Give the template a name.";
  if(charLength(clean) > TEMPLATE_NAME_MAX)
    return `Template names are up to ${TEMPLATE_NAME_MAX} characters — this one is ${charLength(clean)}.`;
  if(NAME_CONTROL.test(clean))
    return "A template name can't contain control characters.";
  if(typeof body !== "string" || charLength(body) < TEMPLATE_BODY_MIN)
    return "Write the template itself — the post with {slots} where the details go.";
  if(charLength(body) > TEMPLATE_BODY_MAX)
    return `A template is up to ${TEMPLATE_BODY_MAX} characters — this one is ${charLength(body)}.`;
  if(BODY_CONTROL.test(body))
    return "A template can't contain control characters — only ordinary text, line breaks and tabs.";
  const slots = parsePlaceholders(body).length;
  if(slots < TEMPLATE_SLOTS_MIN)
    return "Add at least one slot, like {title} — a template with no slots is just fixed text.";
  if(slots > TEMPLATE_SLOTS_MAX)
    return `A template holds up to ${TEMPLATE_SLOTS_MAX} slots — this one has ${slots}.`;
  return "";
}
