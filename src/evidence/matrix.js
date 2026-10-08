/**
 * Evidence matrix: turns sources, conflicts and the model's claims into an overall
 * confidence level plus per-claim support. Confidence is computed from evidence
 * counts and quality, not from how confident the writing sounds.
 */

const LEVELS = ['low', 'medium', 'high'];
const downgrade = (level) => LEVELS[Math.max(0, LEVELS.indexOf(level) - 1)];
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * @param {object} input
 * @param {Array} input.sources scored sources with id, quality, evidenceLevel ('page'|'snippet'), syndicatedFrom, isPrimary, publishedAt, updatedAt
 * @param {Array} input.conflicts from detectConflicts
 * @param {boolean} input.requiresCurrent
 * @param {Array<{text: string, sources: string[], type: string}>} [input.claims]
 * @param {number} [input.now]
 */
export function assessEvidence({ sources, conflicts = [], requiresCurrent = false, claims = [], now = Date.now() }) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const readable = sources.filter((s) => s.evidenceLevel === 'page');
  const independent = readable.filter((s) => !s.syndicatedFrom);
  const primary = independent.filter((s) => s.isPrimary);
  const syndicated = readable.length - independent.length;
  const avgQuality = mean(independent.map((s) => s.quality));
  const reasons = [];

  let level;
  if (independent.length === 0) level = 'low';
  else if (independent.length >= 3 && avgQuality >= 55) level = 'high';
  else if (independent.length >= 2 && avgQuality >= 45) level = 'medium';
  else level = 'low';

  if (!readable.length) {
    reasons.push('No page could be read, so the answer relies on search snippets or general knowledge.');
  } else {
    reasons.push(`${independent.length} independent source${independent.length === 1 ? '' : 's'} read${primary.length ? `, ${primary.length} primary or official` : ''}.`);
  }
  if (syndicated > 0) reasons.push(`${syndicated} source${syndicated === 1 ? ' repeats' : 's repeat'} another source's text and was counted once.`);

  if (conflicts.length) {
    const before = level;
    level = downgrade(level);
    reasons.push(`${conflicts.length} disagreement${conflicts.length === 1 ? '' : 's'} between sources ${before !== level ? 'lowered' : 'affect'} confidence.`);
  }

  if (requiresCurrent && readable.length) {
    const twoYearsMs = 2 * 365 * 86_400_000;
    const recent = readable.filter((s) => {
      const d = Date.parse(s.updatedAt || s.publishedAt || '');
      return Number.isFinite(d) && now - d <= twoYearsMs;
    });
    if (recent.length === 0) {
      level = downgrade(level);
      reasons.push('Few sources are clearly dated within the last two years, which matters for a time-sensitive question.');
    }
  }

  const assessedClaims = claims.map((c) => assessClaim(c, byId, conflicts));

  return {
    confidence: level,
    confidenceReasons: reasons,
    counts: {
      found: sources.length,
      readable: readable.length,
      independent: independent.length,
      primary: primary.length,
      syndicated,
      snippetOnly: sources.length - readable.length,
      conflicts: conflicts.length,
    },
    avgQuality: Math.round(avgQuality),
    claims: assessedClaims,
    unsupportedClaims: assessedClaims.filter((c) => !c.supported).length,
  };
}

function assessClaim(claim, byId, conflicts) {
  const validIds = (claim.sources ?? []).filter((id) => byId.has(id));
  const valid = validIds.map((id) => byId.get(id));
  const independent = valid.filter((s) => s.evidenceLevel === 'page' && !s.syndicatedFrom);
  const best = Math.max(0, ...independent.map((s) => s.quality));

  let confidence;
  if (independent.length >= 2 && best >= 50) confidence = 'high';
  else if (independent.length >= 1 && best >= 45) confidence = 'medium';
  else confidence = 'low';

  const touchesConflict = conflicts.some((c) => c.values.some((v) => validIds.includes(v.sourceId)));
  if (touchesConflict && confidence !== 'low') confidence = downgrade(confidence);

  return {
    text: claim.text,
    type: claim.type === 'judgment' ? 'judgment' : 'fact',
    sources: validIds,
    supported: validIds.length > 0,
    confidence,
    conflicted: touchesConflict,
  };
}
