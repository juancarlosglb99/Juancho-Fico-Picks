/**
 * The side-by-side report.
 *
 * Three opinions about the same board - First Seed's, our deterministic
 * engine's, and the strategist's - printed together with what the guardrails
 * made of the third. The point is to make disagreement visible and legible: if
 * they all agree, the row is short and boring; if they do not, everything
 * needed to judge who is right is on the screen.
 */
import type { BriefCandidate } from '../types';
import type { EvaluatedPick, InterestingPick } from './evaluate';

export function renderInterestingPicks(picks: InterestingPick[]): string[] {
  return picks.map(
    (pick) =>
      `  R${String(pick.round).padStart(2)} p${String(pick.overallPick).padStart(3)} ` +
      `[${pick.score}] ${pick.reasons.join(', ')}${pick.summary ? ` — ${pick.summary}` : ''}`,
  );
}

export function renderEvaluatedPick(evaluated: EvaluatedPick): string[] {
  const lines: string[] = [];
  const { brief, call, decision } = evaluated;
  const response = call.response;

  const bar = '─'.repeat(78);
  lines.push('');
  lines.push(bar);
  lines.push(
    `ROUND ${brief.draft.currentRound}  ·  PICK ${evaluated.overallPick}  ·  ` +
      `seat ${brief.draft.ourDraftSlot}  ·  ${brief.league.teams}-team ${brief.league.scoringProfile} ${brief.league.qbFormat}` +
      `${evaluated.fromCache ? '  ·  cached' : ''}`,
  );
  lines.push(bar);

  lines.push(`  our roster   ${brief.ourTeam.players.map((p) => `${p.position} ${p.name}`).join(', ') || 'empty'}`);
  lines.push(
    `  open slots   ${brief.ourTeam.lineupHoles.flatMap((h) => Array(h.count).fill(h.slot)).join(' ') || 'none'}` +
      `   ·   next turn p${brief.draft.nextOurPick ?? '-'} (${brief.draft.picksUntilOurNextSelection ?? 0} picks away)`,
  );
  lines.push('');

  /* ------------------------------------------------- the three opinions */

  const fs = evaluated.firstSeedBest;
  lines.push(`  FIRST SEED   ${fs ? `#${fs.rank} ${fs.name} (${fs.position})` : '—'}`);

  const det = evaluated.deterministic;
  const detCandidate = brief.candidates.find((entry) => entry.playerId === det?.playerId);
  lines.push(
    `  JUANCHO      ${det ? `${det.name} (${det.position})` : '—'}` +
      (detCandidate ? `  ${describeGap(detCandidate)}  ${describePlan(detCandidate)}` : ''),
  );

  if (call.error) {
    lines.push(`  CLAUDE       call failed — ${call.error}`);
    for (const problem of call.problems ?? []) {
      lines.push(`    REJECTED   ${problem.code} at ${problem.path || '<root>'}: ${problem.message}`);
    }
    lines.push(`  GUARDRAIL    ${decision.outcome}`);
    lines.push(
      `  SHOWN        ${decision.final ? `${decision.final.name} (${decision.final.source})` : '—'}`,
    );
    return lines;
  }
  if (!response) {
    lines.push('  CLAUDE       returned no recommendation');
    return lines;
  }

  const chosen = evaluated.chosen;
  lines.push(
    `  CLAUDE       ${chosen ? `${chosen.name} (${chosen.position})` : response.recommendedPlayerId}` +
      (chosen ? `  ${describeGap(chosen)}  ${describePlan(chosen)}` : '  [not on the board]') +
      `  ·  ${response.decision}  ·  ${response.confidence}% confident`,
  );

  const agreement =
    det && response.recommendedPlayerId === det.playerId
      ? 'agrees with Juancho'
      : fs && chosen && chosen.firstSeed.rank === fs.rank
        ? 'agrees with First Seed, differs from Juancho'
        : 'differs from both';
  lines.push(`               ${agreement}`);
  lines.push('');

  /* ---------------------------------------------------------- the reasoning */

  lines.push(`  strategy     ${wrap(response.strategy, 15)}`);
  for (const reason of response.reasons) {
    lines.push(`  · ${reason.code.padEnd(24)} ${wrap(reason.detail, 28)}`);
  }
  if (response.firstSeedDeviationReason) {
    lines.push(`  FS deviation ${wrap(response.firstSeedDeviationReason, 15)}`);
  }
  lines.push(`  next pick    ${wrap(response.expectedNextPickPlan, 15)}`);
  if (response.opponentsThatMatter.length > 0) {
    for (const opponent of response.opponentsThatMatter) {
      lines.push(`  roster ${String(opponent.rosterId).padEnd(6)} ${wrap(opponent.why, 15)}`);
    }
  }
  lines.push('');

  /* -------------------------------------------------------- the alternatives */

  lines.push('  alternatives');
  response.alternatives.forEach((alternative, index) => {
    const player = evaluated.alternatives[index];
    lines.push(
      `    ${index + 1}. ${player ? `${player.name} (${player.position})` : alternative.playerId}` +
        (player ? `  ${describeGap(player)}  surv ${player.survival.probability ?? '-'}%` : '  [not on the board]'),
    );
    lines.push(`       ${wrap(alternative.reason, 7)}`);
  });
  lines.push('');

  /* ------------------------------------------------------------ guardrails */

  const guardrail = decision.audit.guardrail;
  lines.push(`  GUARDRAIL    ${decision.outcome}`);
  for (const violation of guardrail?.violations ?? []) {
    lines.push(`    BLOCKED    ${violation.code}: ${wrap(violation.message, 15)}`);
  }
  for (const concern of guardrail?.concerns ?? []) {
    lines.push(`    noted      ${concern.code}: ${wrap(concern.message, 15)}`);
  }
  if ((guardrail?.violations.length ?? 0) === 0 && (guardrail?.concerns.length ?? 0) === 0) {
    lines.push('    clean      nothing to report');
  }
  lines.push(
    `  SHOWN        ${decision.final ? `${decision.final.name} (${decision.final.source})` : '—'}`,
  );

  if (call.usage) {
    lines.push(
      `  cost         ${call.usage.inputTokens} in / ${call.usage.outputTokens} out` +
        `  ·  ${call.latencyMs}ms  ·  ${call.model}`,
    );
  }
  return lines;
}

function describeGap(candidate: BriefCandidate): string {
  const rank = candidate.firstSeed.rank;
  const gap = candidate.firstSeed.rankGapFromBestAvailable;
  if (rank === null) return 'unranked by First Seed';
  return `FS#${rank}${gap ? ` (+${gap})` : ''}`;
}

function describePlan(candidate: BriefCandidate): string {
  const plan = candidate.juancho.planValueVsRecommended;
  const rank = candidate.juancho.recommendationRank;
  return `plan ${plan === null ? '—' : `${plan >= 0 ? '+' : ''}${plan}`} · Juancho #${rank ?? '—'} · surv ${candidate.survival.probability ?? '—'}%`;
}

/** Wraps prose to the terminal, hanging-indented under its label. */
function wrap(text: string, indent: number, width = 78): string {
  const pad = ' '.repeat(indent);
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width - indent) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${pad}`);
}
