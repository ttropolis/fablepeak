/* X (Twitter) thread splitting — the composer's half of one shared rule.
 *
 * This is a leaf module on purpose: it imports nothing, so the node suite can
 * load it against the shared fixture table without booting the app, and the
 * composer can import it without dragging the planner's DOM in.
 *
 * splitXThread() here and splitXThread() in
 * supabase/functions/_shared/platforms.ts must agree tweet for tweet, for the
 * same reason effectiveText() must: one of them draws the preview that tells
 * the customer their post will go out as three tweets, and the other decides
 * what X is actually sent. test/fixtures/x-thread-cases.json is the shared
 * truth both suites assert, exactly as effective-text-cases.json binds
 * effectiveText — a semantic change on either side breaks the other side's
 * suite until the fixture is updated with it.
 */

/** X refuses a tweet over 280 characters. */
export const X_TEXT_LIMIT = 280;

/** The widest body a *threaded* tweet may carry, before its " (n/m)" suffix.
 *
 *  275 is the ceiling; the budget actually used is smaller, because " (1/3)"
 *  is six characters and not five. The suffix is `4 + digits(n) + digits(m)`
 *  wide, and n can be as wide as m, so a thread of up to nine tweets reserves
 *  six characters (budget 274) and one of ten to ninety-nine reserves eight
 *  (budget 272). Reserving for the count before the count is known is why
 *  splitXThread() re-splits when the first pass produced more tweets than the
 *  reservation covered: the alternative is emitting a 281-character tweet that
 *  X rejects, which is the one outcome the split exists to prevent. */
export const X_THREAD_TEXT_LIMIT = 275;

/** The single refusal that survives threading.
 *
 *  Everything else that is too long for one tweet becomes several. A word that
 *  is on its own wider than a tweet cannot: breaking it would edit the
 *  customer's copy — a URL, a hash, a long identifier — into something that no
 *  longer means what they wrote. Stated once, thrown by both implementations,
 *  and shown by the composer as the reason it will not save. */
export const X_THREAD_UNSPLITTABLE =
  "This post contains a word longer than a tweet, so X cannot split it into a thread.";

/* Width is counted in code points, never in UTF-16 units, so an emoji is one
   character rather than two and a surrogate pair can never be counted apart.
   Nothing here ever breaks inside a word, so a pair cannot be split either. */
const width = (value) => [...value].length;

/** One paragraph's sentences, each keeping its own trailing punctuation. */
function sentencesOf(block) {
  return block.match(/[^.!?…]*[.!?…]+[)"'\]]*\s*|[^.!?…]+$/gu) ?? [block];
}

/** The indivisible pieces this text breaks into, each already inside `budget`.
 *
 *  Paragraphs first, then — only for a paragraph that does not fit — sentences,
 *  then — only for a sentence that does not fit — words. A piece carries the
 *  separator that rejoins it to the piece before it, so packing can rebuild
 *  paragraph breaks it did not have to spend. A single newline inside a
 *  paragraph survives whenever that paragraph fits whole; a paragraph that has
 *  to be broken down to sentences is rejoined with spaces, because the break
 *  points are the sentence ends. */
function threadPieces(text, budget) {
  const pieces = [];
  let separator = "";
  const push = (piece) => { pieces.push({ text: piece, separator }); separator = " "; };
  for (const paragraph of text.split(/\n[^\S\n]*\n\s*/)) {
    const block = paragraph.trim();
    if (!block) continue;
    if (pieces.length) separator = "\n\n";
    if (width(block) <= budget) { push(block); continue; }
    for (const rawSentence of sentencesOf(block)) {
      const sentence = rawSentence.trim();
      if (!sentence) continue;
      if (width(sentence) <= budget) { push(sentence); continue; }
      for (const word of sentence.split(/\s+/)) {
        if (!word) continue;
        if (width(word) > budget) throw new Error(X_THREAD_UNSPLITTABLE);
        push(word);
      }
    }
  }
  return pieces;
}

/** Greedily fill tweets with pieces, never exceeding `budget`. */
function packPieces(pieces, budget) {
  const tweets = [];
  let current = "";
  for (const piece of pieces) {
    if (!current) { current = piece.text; continue; }
    const candidate = current + piece.separator + piece.text;
    if (width(candidate) <= budget) { current = candidate; continue; }
    tweets.push(current);
    current = piece.text;
  }
  if (current) tweets.push(current);
  return tweets;
}

/** The tweets this post becomes.
 *
 *  A post that already fits is returned as the single tweet it is, byte for
 *  byte and with no suffix: the customer wrote one tweet and gets one tweet.
 *  Only a post that has to be broken is renumbered, and then every tweet in it
 *  carries " (n/m)" — a lone "(1/1)" would be numbering that says nothing.
 *
 *  Throws X_THREAD_UNSPLITTABLE, and nothing else. */
export function splitXThread(text) {
  const source = typeof text === "string" ? text : "";
  if (width(source) <= X_TEXT_LIMIT) return [source];
  let reserve = 6;                       // " (1/9)" — the narrowest suffix
  let tweets = [];
  /* At most four passes, and in practice two: the reservation only ever grows,
     it grows by two characters per extra digit in the tweet count, and a post
     long enough to need a four-digit count is beyond anything the composer or
     the `variants` column will hold. */
  for (let pass = 0; pass < 4; pass++) {
    const budget = Math.min(X_THREAD_TEXT_LIMIT, X_TEXT_LIMIT - reserve);
    tweets = packPieces(threadPieces(source, budget), budget);
    const needed = tweets.length < 2 ? 0 : 4 + 2 * String(tweets.length).length;
    if (needed <= reserve) break;
    reserve = needed;
  }
  // Whitespace-only text over the limit has no pieces at all. It is not a
  // thread and it is not this function's refusal to make; hand it back whole.
  if (tweets.length < 2) return tweets.length ? tweets : [source];
  const total = tweets.length;
  return tweets.map((tweet, index) => `${tweet} (${index + 1}/${total})`);
}
