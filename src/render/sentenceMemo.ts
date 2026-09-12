import type { Sentence, Token } from "../parse/types.ts";

/** Per-sentence memoization for the two render pipelines — the piece of
 * "make an edit incremental" that is the same in both panels: a cache keyed
 * on the one `Sentence` object (stable across edits — an inspector edit
 * mutates a token's fields in place and never replaces the array, never
 * reorders it, never adds or removes a sentence; see `editHistory.ts`'s own
 * `Snapshot`, which is positional for exactly that reason) and invalidated
 * by a fingerprint of what that sentence currently reads as.
 *
 * **The trap this exists to avoid**, named in the report: `token.misc` is
 * written *during* rendering — `chosenReading.ts`'s `setChosenReading` and
 * friends — but only ever from the edit menus, never from the resolver or
 * the generator themselves (verified: grep for `\.misc\s*=`/`delete .*\.misc`
 * across `src` finds writers only in `chosenReading.ts` (UI-triggered),
 * `sourceLayout.ts` (parse-time), `conlluParser.ts` (initial parse) and
 * `editHistory.ts` (undo/redo restore) — none inside `readingResolver.ts`,
 * `generator.ts`, `reorderEngine.ts` or either view). So a fingerprint taken
 * *before* a render and read again *after* it is stable, and a key built
 * from `JSON.stringify(token.misc)` would not be the self-invalidating
 * mistake the report warns about — but it is spelled out field by field even
 * so, in `tokenFingerprint` below, because a fingerprint that silently starts
 * covering some future render-written field is exactly that bug, one commit
 * away, and a named list is the one form of this function that cannot
 * regress that way without the diff saying so. */
export interface SentenceMemo<T> {
  /** Returns the cached value if `fingerprint` still matches what was last
   * stored for `sentence`, else runs `make()`, caches it under the new
   * fingerprint, and returns it. `hit` is `false` on a genuine change (or the
   * first time this sentence is asked about) — the signal the incremental
   * redraw uses to know which sentences it actually has to touch. */
  compute(sentence: Sentence, fingerprint: string, make: () => T): { value: T; hit: boolean };
}

export function createSentenceMemo<T>(): SentenceMemo<T> {
  const store = new WeakMap<Sentence, { fingerprint: string; value: T }>();
  return {
    compute(sentence, fingerprint, make) {
      const entry = store.get(sentence);
      if (entry && entry.fingerprint === fingerprint) return { value: entry.value, hit: true };
      const value = make();
      store.set(sentence, { fingerprint, value });
      return { value, hit: false };
    },
  };
}

/** One token's contribution to its sentence's fingerprint: every field either
 * render pipeline reads, named rather than taken wholesale off `token.misc`
 * (see the module doc) — `LineBreak`/`Indent` (written once, at parse time,
 * by `sourceLayout.ts`) are deliberately included too, since `breakCarriersFor`
 * reads them, but nothing outside this list is, so nothing outside this list
 * needs to be. */
function tokenFingerprint(t: Token): string {
  return [
    t.id,
    t.text,
    t.lemma,
    t.pos,
    t.xpos,
    t.dep,
    t.head,
    t.morph ?? "",
    t.misc?.Reading ?? "",
    t.misc?.Okurigana ?? "",
    t.misc?.ConjClass ?? "",
    t.misc?.Topic ?? "",
    t.misc?.LineBreak ?? "",
    t.misc?.Indent ?? "",
  ].join("");
}

/** A sentence's fingerprint: every token's own, joined, plus `extra` — a
 * session-global input (the 連用形-て display switch is the one that exists)
 * that every sentence's generation also depends on and that no token carries.
 * Folding it in here rather than keying the memo on `[sentence, extra]`
 * separately means one flip of the switch reads as every sentence changing at
 * once, which is exactly what it is: the switch has no sentence of its own to
 * be a token-level edit to, and this is what makes it interoperate with the
 * incremental path (which asks "which sentences are dirty") without a special
 * case for it. */
export function sentenceFingerprint(sentence: Sentence, extra = ""): string {
  return extra + "" + sentence.tokens.map(tokenFingerprint).join("");
}
