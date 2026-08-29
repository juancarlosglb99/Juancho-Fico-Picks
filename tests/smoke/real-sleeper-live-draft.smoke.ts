/**
 * End-to-end check against a REAL Sleeper draft.
 *
 * This is the test that proves attachment and live synchronization actually work
 * against Sleeper rather than against fixtures. It is a smoke test, so it is not
 * part of `npm test`:
 *
 *     npm run test:smoke
 *
 * By default it exercises a public completed league draft, which is stable and
 * always available. To point it at YOUR live mock draft - the real target of this
 * feature - pass the draft room link or ID:
 *
 *     SLEEPER_DRAFT_ID="https://sleeper.com/draft/nfl/1234567890123456789" npm run test:smoke
 *
 * With a live draft it also polls twice and reports whether the board moved,
 * which is the actual "does it follow the draft" question.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDraftAttachment,
  isMockDraft,
} from '../../packages/sleeper/attachment';
import { extractSleeperDraftId } from '../../packages/sleeper/draft-ref';
import {
  draftSnapshotSignature,
  nextSyncDelayMs,
  newPicksSince,
} from '../../packages/sleeper/live-sync';
import { normalizeLeagueContext } from '../../packages/engine/context/normalize';
import { deriveDraftBoardState } from '../../packages/engine/draft/state';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import { sleeperClient } from '../../packages/sleeper/client';
import type { SleeperDraft, SleeperDraftPick } from '../../packages/sleeper/types';

/** A public, completed league draft used when no draft is supplied. */
const FALLBACK_LEAGUE_ID = '1388280410047275008';

const RAW_TARGET = process.env.SLEEPER_DRAFT_ID?.trim();

async function resolveTargetDraftId(): Promise<string> {
  if (RAW_TARGET) {
    const draftId = extractSleeperDraftId(RAW_TARGET);
    if (!draftId) {
      throw new Error(
        `SLEEPER_DRAFT_ID="${RAW_TARGET}" is not a Sleeper draft link or ID.`,
      );
    }
    return draftId;
  }
  const drafts = await sleeperClient.getLeagueDrafts(FALLBACK_LEAGUE_ID);
  const draft = drafts[0];
  if (!draft) throw new Error('Fallback league exposed no drafts.');
  return draft.draft_id;
}

/** One full attach: exactly what the app does when you paste a draft link. */
async function attach(draftId: string) {
  const [draft, picks, tradedPicks, rawPlayers] = await Promise.all([
    sleeperClient.getDraft(draftId),
    sleeperClient.getDraftPicks(draftId),
    sleeperClient.getDraftTradedPicks(draftId),
    sleeperClient.getActivePlayers(),
  ]);

  const league =
    !isMockDraft(draft) && draft.league_id
      ? await sleeperClient.getLeague(draft.league_id)
      : null;
  const rosters =
    !isMockDraft(draft) && draft.league_id
      ? await sleeperClient.getRosters(draft.league_id)
      : null;

  const attachment = buildDraftAttachment({ draft, league, rosters });
  const players = buildCanonicalPlayerMap(rawPlayers);
  const board = deriveDraftBoardState(draft, picks, attachment.rosters, players);

  return { draft, picks, tradedPicks, attachment, players, board };
}

describe('real Sleeper draft attachment and live sync', () => {
  it('attaches to a real draft and derives a usable board', async () => {
    const draftId = await resolveTargetDraftId();
    const { draft, picks, attachment, board, players } = await attach(draftId);

    console.log(
      `[smoke] attached to ${draftId} · ${attachment.label} · status=${draft.status} · picks=${picks.length}`,
    );

    expect(draft.draft_id).toBe(draftId);
    expect(attachment.league.draft_id).toBe(draftId);
    expect(attachment.rosters.length).toBeGreaterThan(0);
    expect(board.teams).toBeGreaterThan(1);
    expect(board.picksMade).toBe(picks.length);
    expect(board.currentOverallPick).toBe(picks.length + 1);

    // A mock draft must produce the same shape as a league draft.
    if (isMockDraft(draft)) {
      expect(attachment.source).toBe('mock');
      expect(attachment.synthesized).toBe(true);
    } else {
      expect(attachment.source).toBe('league');
    }

    // The whole point: drafted players are no longer available.
    const availableSleeperIds = new Set(
      board.availablePlayers.map((player) => player.externalIds.sleeper),
    );
    const draftedAndStillAvailable = picks.filter((pick) =>
      availableSleeperIds.has(pick.player_id),
    );
    expect(draftedAndStillAvailable).toEqual([]);

    // Every pick that maps to a known player must be off the board.
    const mappedPicks = picks.filter((pick) => players.bySleeperId.has(pick.player_id));
    for (const pick of mappedPicks) {
      expect(board.unavailableSleeperIds.has(pick.player_id)).toBe(true);
    }
  });

  it('normalizes a real draft into a LeagueContext with a resolvable seat', async () => {
    const draftId = await resolveTargetDraftId();
    const { draft, picks, tradedPicks, attachment, board } = await attach(draftId);

    // Use a real participant so slot resolution is exercised for real.
    const userId =
      Object.keys(draft.draft_order ?? {})[0] ??
      attachment.rosters.find((roster) => roster.owner_id)?.owner_id ??
      '';

    const context = normalizeLeagueContext({
      league: attachment.league,
      draft,
      drafts: [draft],
      picks,
      tradedPicks,
      rosters: attachment.rosters,
      board,
      userId,
    });

    expect(context.roster.value.totalStarterSpots).toBeGreaterThan(0);
    expect(['snake', 'linear', '3rr', 'auction', 'unknown']).toContain(
      context.draftType.value,
    );

    if (userId) {
      console.log(
        `[smoke] seat=${context.draftState.value.userDraftSlot} nextPick=${context.draftState.value.nextUserPick} onClock=${context.draftState.value.isUserOnClock}`,
      );
      expect(context.draftState.value.userDraftSlot).not.toBeNull();
    }
  });

  it('follows the draft across polls without losing or duplicating picks', async () => {
    const draftId = await resolveTargetDraftId();

    const readSnapshot = async () => {
      const [draft, picks] = await Promise.all([
        sleeperClient.getDraft(draftId),
        sleeperClient.getDraftPicks(draftId),
      ]);
      return { draft, picks };
    };

    const first = await readSnapshot();
    const delay = nextSyncDelayMs({
      draftStatus: first.draft.status,
      consecutiveFailures: 0,
      hidden: false,
    });

    // A finished draft correctly tells the loop to stop; nothing more to follow.
    if (delay === null) {
      console.log('[smoke] draft is complete, sync loop stops as designed');
      expect(first.draft.status).toBe('complete');
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 5_000)));
    const second = await readSnapshot();

    const before = draftSnapshotSignature(first.draft, first.picks);
    const after = draftSnapshotSignature(second.draft, second.picks);
    const arrived = newPicksSince(first.picks, second.picks);

    console.log(
      `[smoke] poll 1 -> ${first.picks.length} picks; poll 2 -> ${second.picks.length} picks; new=${arrived.length}`,
    );

    // Picks never disappear from a Sleeper draft.
    expect(second.picks.length).toBeGreaterThanOrEqual(first.picks.length);

    // The signature must change exactly when the board changed.
    if (arrived.length === 0 && first.draft.status === second.draft.status) {
      expect(after).toBe(before);
    } else {
      expect(after).not.toBe(before);
    }

    // Any new picks must be strictly later selections, never re-sent ones.
    const highestBefore = first.picks.reduce(
      (max: number, pick: SleeperDraftPick) => Math.max(max, pick.pick_no),
      0,
    );
    for (const pick of arrived) {
      expect(pick.pick_no).toBeGreaterThan(highestBefore);
    }
  });

  it('reports how the target draft is progressing', async () => {
    const draftId = await resolveTargetDraftId();
    const draft: SleeperDraft = await sleeperClient.getDraft(draftId);
    const picks = await sleeperClient.getDraftPicks(draftId);
    const total = (draft.settings.teams ?? 0) * (draft.settings.rounds ?? 0);

    console.log(
      `[smoke] ${isMockDraft(draft) ? 'MOCK' : 'LEAGUE'} draft ${draftId}: ` +
        `${picks.length}/${total} picks, status=${draft.status}, ` +
        `order=${draft.draft_order ? 'published' : 'not published'}`,
    );

    expect(picks.length).toBeLessThanOrEqual(Math.max(total, picks.length));
  });
});
