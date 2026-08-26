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
 * Prefers, in order: (1) whichever member has an INVERT-classified
 * relation — the most syntactically specific edge a span member can carry;
 * (2) among the rest, whichever member is nominal (NOUN/PROPN/PRON) — for
 * an attributive-modifier + noun span (e.g. an adjective directly modifying
 * its head noun), the noun is the semantic head that should decide the
 * whole phrase's case particle/copula, not whichever word happens to come
 * first; (3) the first token in source order, so behavior is still
 * deterministic even for a span neither heuristic can confidently
 * disambiguate. */
export function carrierOf(span: CompoundSpan, sentence: Sentence): Token {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const members = span.tokenIds.map((id) => byId.get(id)).filter((t): t is Token => !!t);
  if (members.length === 0) return byId.get(span.tokenIds[0])!;

  const invertMember = members.find((t) => classifyToken(t) === "invert");
  if (invertMember) return invertMember;

  const nominalMember = members.find((t) => NOMINAL_PREDICATE_POS.has(t.pos));
  if (nominalMember) return nominalMember;

  return members[0];
}
