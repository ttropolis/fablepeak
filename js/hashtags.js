/* Hashtag groups — the shared vocabulary (ADR 0005 publishing depth).
 *
 * A group is a named, reusable set of tags belonging to one brand:
 * `{ id, name, tags: ["#launch", "#build"] }`. Settings creates and edits them;
 * the composer drops one into the post it is writing; Settings' backup importer
 * checks a file's groups against the same rules. Three call sites, one set of
 * limits — so they live in a leaf module that imports nothing, the way
 * js/escape.js does, rather than being restated in each.
 *
 * The limits below are the same ones `hashtag_groups_tags_valid` enforces in
 * 20260831130000_hashtag_groups.sql. The database is the last line, not the
 * first: a rule stated only here would be a rule a replayed backup or a psql
 * session could walk past, and a rule stated only there would reach the customer
 * as a raw Postgres constraint name.
 */

export const GROUP_NAME_MAX = 60;
export const GROUP_TAGS_MIN = 1;
export const GROUP_TAGS_MAX = 30;
export const TAG_MIN = 2;                       // "#" plus at least one character
export const TAG_MAX = 100;
/* Whitespace is what separates one hashtag from the next, so a tag containing
   it would silently become two. Control characters are refused rather than
   repaired: a tag is rendered back into this app and appended to post text. */
const TAG_WHITESPACE = /\s/;
const TAG_CONTROL = /[\u0000-\u001F\u007F]/;

/** Is this one storable tag? Mirrors the CHECK's per-element predicate. */
export function validTag(tag){
  return typeof tag === "string" && tag.startsWith("#")
    && tag.length >= TAG_MIN && tag.length <= TAG_MAX
    && !TAG_WHITESPACE.test(tag) && !TAG_CONTROL.test(tag);
}
/** Is this a storable tag array? Mirrors valid_hashtag_group_tags(). */
export function validTags(tags){
  return Array.isArray(tags) && tags.length >= GROUP_TAGS_MIN
    && tags.length <= GROUP_TAGS_MAX && tags.every(validTag);
}
/** Is this a storable group? The shape the sync writes and a backup carries. */
export function validHashtagGroup(group){
  return !!group && typeof group === "object" && !Array.isArray(group)
    && typeof group.id === "string" && group.id.length > 0 && group.id.length <= 200
    && typeof group.name === "string"
    && group.name.length >= 1 && group.name.length <= GROUP_NAME_MAX
    && validTags(group.tags);
}

/** One brand's groups, always an array — a brand created before this feature
    simply has none, which is not an error. */
export function groupsOf(b){
  return Array.isArray(b?.hashtag_groups) ? b.hashtag_groups : [];
}

/* What the customer types in the Settings textarea, turned into tags.
   Split on whitespace *and* commas, because both are how people write a tag
   list, and prepend the `#` a customer omits — typing "launch build" and
   getting "#launch #build" is the behaviour that makes this worth having.
   A run of leading `#` collapses to one so "##launch" is not a second spelling
   of the same tag. Nothing else is repaired: a tag that is still not storable
   after this is reported by name (see describeTagProblem). */
export function parseTags(input){
  return String(input ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(word => "#" + word.replace(/^#+/, ""));
}

/** Why this tag cannot be stored, as a sentence — or "" when it can. */
export function describeTagProblem(tag){
  if(typeof tag !== "string" || !tag.startsWith("#")) return "Every tag has to start with #.";
  if(tag.length < TAG_MIN) return "“#” on its own isn't a hashtag — write the word after it.";
  if(tag.length > TAG_MAX) return `“${tag.slice(0, 20)}…” is longer than ${TAG_MAX} characters.`;
  if(TAG_CONTROL.test(tag)) return "A tag can't contain control characters.";
  if(TAG_WHITESPACE.test(tag)) return "A tag can't contain spaces.";
  return "";
}
/** Why this name and tag list cannot be saved, as a sentence — or "" when they
    can. One message at a time, in the order the customer meets the fields. */
export function describeGroupProblem(name, tags){
  const clean = String(name ?? "").trim();
  if(!clean) return "Give the group a name.";
  if(clean.length > GROUP_NAME_MAX)
    return `Group names are up to ${GROUP_NAME_MAX} characters — this one is ${clean.length}.`;
  if(!Array.isArray(tags) || tags.length < GROUP_TAGS_MIN)
    return "Add at least one hashtag.";
  if(tags.length > GROUP_TAGS_MAX)
    return `A group holds up to ${GROUP_TAGS_MAX} hashtags — this one has ${tags.length}.`;
  for(const tag of tags){
    const problem = describeTagProblem(tag);
    if(problem) return problem;
  }
  return "";
}

/* Insertion — the composer's half, kept here because "which tags does this text
   already carry?" is the same question the group list asks and the same one a
   test wants to make an assertion about without a DOM.

   A tag already in the post is skipped rather than repeated: appending
   "#launch" to a post that says "#launch" is a mistake no customer means to
   make. The comparison is case-insensitive because Instagram's is, so #Launch
   and #launch are one tag. Returns the text to write and the tags that were
   actually added, so the caller can say what happened. */
export function appendTags(text, tags){
  const body = String(text ?? "").replace(/\s+$/, "");
  const present = new Set(body.split(/\s+/).filter(Boolean).map(word => word.toLowerCase()));
  const added = [];
  for(const tag of tags){
    const key = String(tag).toLowerCase();
    if(!validTag(tag) || present.has(key)) continue;
    present.add(key);
    added.push(tag);
  }
  if(!added.length) return { text: String(text ?? ""), added };
  // A blank line keeps a tag block from running into the last sentence, which
  // is how a hashtag block is written everywhere it is written.
  return { text: body ? `${body}\n\n${added.join(" ")}` : added.join(" "), added };
}
