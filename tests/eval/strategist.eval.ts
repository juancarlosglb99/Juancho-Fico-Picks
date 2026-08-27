/**
 * The strategist evaluation.
 *
 *     npm run strategist:eval -- <draftId>              the disputed selections
 *     npm run strategist:eval -- <draftId> 69 89        specific selections
 *     npm run strategist:eval -- <draftId> --all        every selection we own
 *     npm run strategist:eval -- <draftId> --list       find them, call nothing
 *     npm run strategist:eval -- <draftId> 69 --refresh ignore the cache
 *
 * This is NOT part of `npm test`. It calls a real model over the network and
 * costs real money, and nothing it produces touches the recommendation path -
 * the strategist's answer is computed, guarded and printed, never applied.
 *
 * Answers are cached by the exact payload sent, so re-running is free until the
 * playbook, the brief or the compression changes.
 */
import { describe, expect, it } from 'vitest';
import {
  listCases,
  readProjectionSnapshot,
  readRoomSnapshot,
} from '../../packages/engine/benchmark/store';
import { ourPickNumbers } from '../../packages/engine/benchmark/brief-replay';
import {
  AnthropicStrategist,
  resolveStrategistModel,
} from '../../packages/engine/strategist/anthropic/client';
import {
  evaluatePick,
  findInterestingPicks,
  type EvaluationInput,
} from '../../packages/engine/strategist/anthropic/evaluate';
import {
  renderEvaluatedPick,
  renderInterestingPicks,
} from '../../packages/engine/strategist/anthropic/report';
import { buildDraftAttachment } from '../../packages/sleeper/attachment';
import { draftFor, playersFor } from '../regression/replay-harness';

const DRAFT_ID = process.env.JUANCHO_EVAL_DRAFT ?? '';
const PICKS = (process.env.JUANCHO_EVAL_PICKS ?? '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const ALL = process.env.JUANCHO_EVAL_ALL === '1';
const LIST_ONLY = process.env.JUANCHO_EVAL_LIST === '1';
const REFRESH = process.env.JUANCHO_EVAL_REFRESH === '1';
/** Default budget when nobody names selections: enough to judge, few enough to afford. */
const DEFAULT_LIMIT = Number(process.env.JUANCHO_EVAL_LIMIT ?? 3);

function inputFor(draftId: string): EvaluationInput {
  const cases = listCases();
  const entry = cases.find((item) => item.draftId === draftId);
  if (!entry) {
    throw new Error(
      `No saved mock "${draftId}". The corpus holds: ${cases.map((item) => item.draftId).join(', ')}`,
    );
  }
  const draft = draftFor(entry);
  const attachment = buildDraftAttachment({ draft, league: null, rosters: null });
  return {
    regression: entry,
    projections: readProjectionSnapshot(entry.projectionsRef),
    roomRankings: entry.roomRankingsRef ? readRoomSnapshot(entry.roomRankingsRef) : null,
    players: playersFor(entry),
    league: attachment.league,
    draft,
    rosters: attachment.rosters,
  };
}

describe('strategist evaluation', () => {
  it('reports the strategist against First Seed and Juancho', async () => {
    if (!DRAFT_ID) {
      throw new Error('Pass a draft id: npm run strategist:eval -- <draftId>');
    }
    const input = inputFor(DRAFT_ID);
    const model = resolveStrategistModel();

    const interesting = findInterestingPicks(input);
    console.log(
      `\n[eval] ${DRAFT_ID} · seat ${input.regression.userSlot} · ` +
        `${input.regression.format.teams}-team ${input.regression.format.scoringProfile} ` +
        `${input.regression.format.qbFormat} · model ${model}`,
    );
    console.log(`[eval] selections in dispute (${interesting.length} of ${ourPickNumbers(input.regression).length}):`);
    for (const line of renderInterestingPicks(interesting)) console.log(line);

    /*
     * Explicit selections win; otherwise the most disputed few. Never all of
     * them unless asked, because forty-five paid calls to look at three
     * interesting ones is a waste.
     */
    const chosen = PICKS.length
      ? PICKS
      : ALL
        ? ourPickNumbers(input.regression)
        : interesting.slice(0, DEFAULT_LIMIT).map((pick) => pick.overallPick);

    console.log(
      `[eval] evaluating ${chosen.length} selection${chosen.length === 1 ? '' : 's'}: ${chosen.join(', ')}` +
        (LIST_ONLY ? ' (list only, calling nothing)' : ''),
    );
    if (LIST_ONLY) {
      expect(interesting.length).toBeGreaterThan(0);
      return;
    }

    const strategist = new AnthropicStrategist();
    // Stamped once so a whole run shares a timestamp, and nothing deeper in the
    // engine ever has to read the clock.
    const now = new Date().toISOString();

    let paid = 0;
    for (const overallPick of chosen.sort((a, b) => a - b)) {
      const evaluated = await evaluatePick(input, overallPick, {
        strategist,
        model,
        now,
        refresh: REFRESH,
      });
      if (!evaluated) {
        console.log(`\n[eval] pick ${overallPick}: no brief could be built`);
        continue;
      }
      if (!evaluated.fromCache) paid += 1;
      for (const line of renderEvaluatedPick(evaluated)) console.log(line);

      // The harness is judged on producing a verdict, not on agreeing with one.
      expect(evaluated.decision.outcome).toBeTruthy();
    }

    console.log(
      `\n[eval] done · ${paid} paid call${paid === 1 ? '' : 's'} · ` +
        `${chosen.length - paid} served from cache`,
    );
  });
});
