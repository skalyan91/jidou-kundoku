import type { Sentence, Token } from "../parse/types.ts";
import type { CompoundSpan } from "../reading/jmdictLookup.ts";
import { classifyToken } from "./depClassification.ts";
import { NOMINAL_PREDICATE_POS } from "../kakikudashi/conjugationContext.ts";

/** The single member of a multi-character span that anchors its placement
 * in the reordered tree and carries its syntactic relation (case particle,
 * kundoku-ten jump, etc.). Real classical Chinese compounds like 遠方
 * ("distant place") are frequently split across two different SUD heads by
 * the parser — one member attached as a genuine complement of one token,
 * the other as a looser modifier of a completely different token — even
 * though they are one lexical/orthographic unit that must be read, marked,
 * and moved together (the kanbun convention for this is a vertical
 * connecting line joining the characters).
 *
 * Only a member whose own head lies *outside* the span can do that job. The
 * span is placed by walking to its carrier through the carrier's head edge,
 * and `computeReadingOrder` drops every other member from the tree, so a
 * carrier attached to one of its own span-mates hangs off a node that is no
 * longer there: nothing reaches it from the root, and the entire span goes
 * missing from the reading order. 黃帝者、少典之子也 is the case that showed
 * this — 黃 is a `compound` of 帝 and 帝 a `mod` of 者, so 帝 is the one
 * member holding the span onto the sentence, and choosing 黃 (as the nominal
 * rule below did, 黃 being PROPN and first) lost 黃帝 from the kakikudashi
 * entirely. A member that *is* the root is a carrier in its own right, the
 * walk starting there rather than arriving along an edge.
 *
 * Among those candidates it prefers, in order: (1) whichever member has an
 * INVERT-classified relation — the most syntactically specific edge a span
 * member can carry; (2) among the rest, whichever member is nominal
 * (NOUN/PROPN/PRON) — for an attributive-modifier + noun span (e.g. an
 * adjective directly modifying its head noun), the noun is the semantic head
 * that should decide the whole phrase's case particle/copula, not whichever
 * word happens to come first; (3) the first token in source order, so
 * behavior is still deterministic even for a span neither heuristic can
 * confidently disambiguate. */
export function carrierOf(span: CompoundSpan, sentence: Sentence): Token {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const members = span.tokenIds.map((id) => byId.get(id)).filter((t): t is Token => !!t);
  if (members.length === 0) return byId.get(span.tokenIds[0])!;

  const inSpan = new Set(span.tokenIds);
  const attached = members.filter((t) => t.head === t.id || !inSpan.has(t.head));
  // Every member attached inside the span means the span's own edges say it
  // is detached from the sentence, which no real parse of a span should be.
  // Rather than return nothing, fall back to the whole membership and let the
  // heuristics below choose — the same span this produced before.
  const candidates = attached.length > 0 ? attached : members;

  const invertMember = candidates.find((t) => classifyToken(t) === "invert");
  if (invertMember) return invertMember;

  const nominalMember = candidates.find((t) => NOMINAL_PREDICATE_POS.has(t.pos));
  if (nominalMember) return nominalMember;

  return candidates[0];
}
