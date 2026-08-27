/**
 * The brief, built from the real drafts in the corpus.
 *
 * A brief assembled from a synthetic board proves the shape is right. It does
 * not prove the thing that actually matters, which is that at every real
 * selection of every real mock the strategist would have been handed a complete
 * and honest picture: every opponent, nobody who is already gone, and the
 * player Juancho itself would have taken.
 *
 *     npm run test:regression
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildBriefAtPick,
  ourPickNumbers,
} from '../../packages/engine/benchmark/brief-replay';
import { listCases, readProjectionSnapshot, readRoomSnapshot } from '../../packages/engine/benchmark/store';
import { validateStrategistPick } from '../../packages/engine/strategist/guardrails';
import { buildDraftAttachment } from '../../packages/sleeper/attachment';
import { draftFor, playersFor, replayCase } from './replay-harness';

const cases = listCases();

function inputFor(entry: (typeof cases)[number]) {
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

describe('the brief on real drafts', () => {
  it.each(cases.map((entry) => ({ entry, name: entry.draftId })))(
    'is complete at every selection of $name',
    ({ entry }) => {
      const input = inputFor(entry);
      const picks = ourPickNumbers(entry);
      expect(picks.length).toBeGreaterThan(0);

      for (const overallPick of picks) {
        const brief = buildBriefAtPick(input, overallPick);
        expect(brief, `no brief at pick ${overallPick}`).not.toBeNull();
        const at = `pick ${overallPick}`;

        // The whole room, described team by team.
        expect(brief!.opponents, at).toHaveLength(entry.format.teams - 1);
        expect(brief!.ourTeam.isUs, at).toBe(true);
        expect(brief!.ourTeam.draftSlot, at).toBe(entry.userSlot);

        // Nobody who is already gone.
        const drafted = new Set(brief!.room.allDraftedPlayerIds);
        const ghosts = brief!.candidates.filter((candidate) => drafted.has(candidate.playerId));
        expect(ghosts.map((candidate) => candidate.name), at).toEqual([]);

        // Whatever Juancho would have taken is always visible.
        const recommended = brief!.deterministic.recommended;
        expect(recommended, at).not.toBeNull();
        expect(
          brief!.candidates.some((candidate) => candidate.playerId === recommended!.playerId),
          at,
        ).toBe(true);

        /*
         * Legality is deliberately NOT asserted here.
         *
         * This board keeps the picks a person really made, and the oldest case
         * in the corpus is the nine-quarterback draft that started all of this.
         * That roster genuinely cannot field a legal lineup by round fourteen,
         * and a guardrail that said otherwise would be broken. What the engine
         * builds today is checked below, against the replayed board.
         */

        // The state it describes is the state it was built from.
        expect(brief!.state.picksMade, at).toBe(overallPick - 1);
        expect(brief!.state.currentOverallPick, at).toBe(overallPick);
        expect(brief!.state.isOurSelection, at).toBe(true);

        // Serializable, because it has to survive a round trip to an API.
        expect(() => JSON.stringify(brief), at).not.toThrow();
      }
    },
  );

  it.each(cases.map((entry) => ({ entry, name: entry.draftId })))(
    'separates First Seed from Juancho on $name',
    ({ entry }) => {
      const input = inputFor(entry);
      const brief = buildBriefAtPick(input, ourPickNumbers(entry)[2])!;

      const ranked = brief.candidates.filter((candidate) => candidate.firstSeed.rank !== null);
      expect(ranked.length, 'the corpus pins a First Seed board').toBeGreaterThan(0);

      for (const candidate of ranked.slice(0, 20)) {
        expect(candidate.firstSeed.rank).toBeTypeOf('number');
        expect(candidate.juancho.projectedPoints).toBeTypeOf('number');
        expect(candidate.firstSeed.rankGapFromBestAvailable).toBeTypeOf('number');
      }

      // The two boards genuinely disagree, which is the whole reason to keep
      // them apart: a blended score would hide exactly this.
      const disagreements = ranked.filter(
        (candidate) =>
          candidate.juancho.boardRank !== null &&
          Math.abs(candidate.juancho.boardRank - candidate.firstSeed.rank!) > 5,
      );
      expect(disagreements.length).toBeGreaterThan(0);
    },
  );

  it.each(cases.map((entry) => ({ entry, name: entry.draftId })))(
    "passes its own guardrails at every pick the engine makes on $name",
    ({ entry }) => {
      /*
       * The replayed board, not the historical one.
       *
       * Here our seat is drafted by the CURRENT engine, so the roster is the
       * one it would actually build. If its own recommendation ever fails the
       * guardrails on a roster of its own making, one of the two is wrong and
       * this is where that shows up.
       */
      const { briefs } = replayCase(entry, { collectBriefs: true });
      expect(briefs.length).toBeGreaterThan(0);

      for (const brief of briefs) {
        const recommended = brief.deterministic.recommended;
        expect(recommended, `pick ${brief.draft.currentOverallPick}`).not.toBeNull();
        const verdict = validateStrategistPick(
          {
            playerId: recommended!.playerId,
            reasoning: 'Deterministic recommendation.',
            reasonCodes: [],
            confidence: 1,
          },
          brief,
        );
        expect(
          verdict.violations.map((violation) => `${violation.code}: ${violation.message}`),
          `R${brief.draft.currentRound} pick ${brief.draft.currentOverallPick}: ${recommended!.name} (${recommended!.position})`,
        ).toEqual([]);
      }
    },
  );

  /**
   * Prints what a real brief actually contains, and writes one out on request.
   *
   *     npm run brief
   *
   * The example is generated rather than written by hand, so it can never
   * describe a shape the code stopped producing.
   */
  it('reports what a real brief contains', () => {
    const wanted = process.env.JUANCHO_BRIEF_DRAFT;
    const entry = (wanted ? cases.find((item) => item.draftId === wanted) : cases[0]) ?? cases[0];
    if (!entry) return;
    const input = inputFor(entry);
    const picks = ourPickNumbers(entry);
    const sample = [picks[0], picks[Math.floor(picks.length / 2)], picks.at(-1)!];

    console.log(`\n[brief] ${entry.draftId} · seat ${entry.userSlot} · ${entry.format.teams}-team`);
    for (const overallPick of sample) {
      const brief = buildBriefAtPick(input, overallPick)!;
      const bytes = JSON.stringify(brief).length;
      const section = (value: unknown) => (JSON.stringify(value).length / 1024).toFixed(0);
      console.log(
        `  R${String(brief.draft.currentRound).padStart(2)} p${String(overallPick).padStart(3)} · ` +
          `${brief.candidates.length} candidates · ${brief.opponents.length} opponents · ` +
          `${brief.room.recentPicks.length} recent picks · ` +
          `${brief.room.tierCliffs.filter((cliff) => cliff.atRisk).length} tiers at risk · ` +
          `${(bytes / 1024).toFixed(0)}KB ` +
          `(candidates ${section(brief.candidates)}KB · teams ${section([brief.ourTeam, ...brief.opponents])}KB · room ${section(brief.room)}KB)`,
      );
    }

    const out = process.env.JUANCHO_BRIEF_OUT;
    if (out) {
      const at = Number(process.env.JUANCHO_BRIEF_PICK ?? sample[1]);
      const brief = buildBriefAtPick(input, at)!;
      writeFileSync(out, `${JSON.stringify(brief, null, 2)}\n`, 'utf8');
      console.log(`[brief] wrote pick ${at} of ${entry.draftId} to ${out}`);
    }

    expect(picks.length).toBeGreaterThan(0);
  });
});
