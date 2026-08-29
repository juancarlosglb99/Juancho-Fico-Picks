/**
 * The pasted draft id is the source of truth, from parse to attachment.
 *
 * The bug these cover: a user pasted a mock draft link and landed in their
 * league's normal draft. Nothing rewrote the id - a league attach started
 * earlier simply finished later, because loading a league is a second round
 * trip, and the stale result overwrote the mock. So there are two things to
 * hold: the id survives every hop, and only the newest attach may write.
 */
import { describe, expect, it } from 'vitest';
import {
  createAttachSequence,
  formatAttachError,
  resolveDraftAttachment,
  type DraftAttachmentClient,
} from '../../packages/sleeper/attach';
import { buildDraftAttachment } from '../../packages/sleeper/attachment';
import { SleeperApiError } from '../../packages/sleeper/client';
import { parseSleeperDraftRef } from '../../packages/sleeper/draft-ref';
import type { SleeperDraft, SleeperLeague, SleeperRoster } from '../../packages/sleeper/types';
import { makeDraft, makeLeague, makeRosters } from '../engine/fixtures';

const MOCK_ID = '1398412036827783168';
const LEAGUE_DRAFT_ID = '1389751147484422145';
const SECOND_LEAGUE_DRAFT_ID = '1389751147484422999';
const LEAGUE_ID = '1389751147484422144';

function mockDraft(): SleeperDraft {
  return { ...makeDraft({ leagueId: null, teams: 10 }), draft_id: MOCK_ID };
}

function leagueDraft(draftId: string): SleeperDraft {
  return { ...makeDraft({ leagueId: LEAGUE_ID }), draft_id: draftId };
}

function league(): SleeperLeague {
  return { ...makeLeague(), league_id: LEAGUE_ID, name: 'Escorpiones' };
}

interface FakeOptions {
  /** Milliseconds before `getLeague`/`getRosters` resolve. */
  leagueDelayMs?: number;
}

function fakeClient(drafts: SleeperDraft[], options: FakeOptions = {}) {
  const asked: string[] = [];
  const byId = new Map(drafts.map((draft) => [draft.draft_id, draft]));

  const client: DraftAttachmentClient = {
    async getDraft(draftId) {
      asked.push(draftId);
      const found = byId.get(draftId);
      if (!found) throw new SleeperApiError('not found', 404, `/draft/${draftId}`);
      return found;
    },
    async getDraftPicks() {
      return [];
    },
    async getDraftTradedPicks() {
      return [];
    },
    async getActivePlayers() {
      return {};
    },
    async getLeague(leagueId) {
      await delay(options.leagueDelayMs ?? 0);
      return { ...league(), league_id: leagueId };
    },
    async getRosters() {
      await delay(options.leagueDelayMs ?? 0);
      return makeRosters(12) as SleeperRoster[];
    },
  };

  return { client, asked };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('a pasted draft link resolves to that exact draft', () => {
  it('opens a standalone mock, and never looks for a league', async () => {
    const parsed = parseSleeperDraftRef(`https://sleeper.com/draft/nfl/${MOCK_ID}`);
    expect(parsed.ok && parsed.ref.draftId).toBe(MOCK_ID);

    const { client, asked } = fakeClient([mockDraft()]);
    const resolved = await resolveDraftAttachment(client, MOCK_ID);

    expect(resolved.draftId).toBe(MOCK_ID);
    expect(asked).toEqual([MOCK_ID]);
    expect(resolved.league).toBeNull();

    const attachment = buildDraftAttachment({
      draft: resolved.draft,
      league: resolved.league,
      rosters: resolved.rosters,
    });
    expect(attachment.source).toBe('mock');
    expect(attachment.draft.draft_id).toBe(MOCK_ID);
  });

  it('keeps a league-associated draft as the pasted one, not the league default', async () => {
    /*
     * The league's own `draft_id` points at a DIFFERENT draft. Canonicalizing to
     * it is the exact failure being guarded against.
     */
    const canonical = { ...league(), draft_id: LEAGUE_DRAFT_ID };
    const { client } = fakeClient([leagueDraft(SECOND_LEAGUE_DRAFT_ID)]);
    const resolved = await resolveDraftAttachment(client, SECOND_LEAGUE_DRAFT_ID, {
      league: canonical,
      rosters: makeRosters(12) as SleeperRoster[],
    });

    expect(canonical.draft_id).not.toBe(SECOND_LEAGUE_DRAFT_ID);
    expect(resolved.draftId).toBe(SECOND_LEAGUE_DRAFT_ID);
    expect(resolved.draft.draft_id).toBe(SECOND_LEAGUE_DRAFT_ID);
    expect(resolved.league?.league_id).toBe(LEAGUE_ID);

    const attachment = buildDraftAttachment({
      draft: resolved.draft,
      league: resolved.league,
      rosters: resolved.rosters,
    });
    expect(attachment.draft.draft_id).toBe(SECOND_LEAGUE_DRAFT_ID);
  });

  it('still attaches an ordinary league draft, with its league behind it', async () => {
    const parsed = parseSleeperDraftRef(`https://sleeper.com/draft/nfl/${LEAGUE_DRAFT_ID}`);
    expect(parsed.ok && parsed.ref.draftId).toBe(LEAGUE_DRAFT_ID);

    const { client } = fakeClient([leagueDraft(LEAGUE_DRAFT_ID)]);
    const resolved = await resolveDraftAttachment(client, LEAGUE_DRAFT_ID);

    expect(resolved.draftId).toBe(LEAGUE_DRAFT_ID);
    expect(resolved.league?.league_id).toBe(LEAGUE_ID);
    expect(resolved.rosters).toHaveLength(12);
    expect(
      buildDraftAttachment({
        draft: resolved.draft,
        league: resolved.league,
        rosters: resolved.rosters,
      }).source,
    ).toBe('league');
  });

  it('keeps two drafts of the same league distinct', async () => {
    const { client } = fakeClient([
      leagueDraft(LEAGUE_DRAFT_ID),
      leagueDraft(SECOND_LEAGUE_DRAFT_ID),
    ]);

    const first = await resolveDraftAttachment(client, LEAGUE_DRAFT_ID);
    const second = await resolveDraftAttachment(client, SECOND_LEAGUE_DRAFT_ID);

    expect(first.draftId).toBe(LEAGUE_DRAFT_ID);
    expect(second.draftId).toBe(SECOND_LEAGUE_DRAFT_ID);
    expect(first.league?.league_id).toBe(second.league?.league_id);
  });

  it('reports a missing draft plainly instead of falling back to anything', async () => {
    const { client } = fakeClient([leagueDraft(LEAGUE_DRAFT_ID)]);
    await expect(resolveDraftAttachment(client, '999999999999999999')).rejects.toBeInstanceOf(
      SleeperApiError,
    );

    const message = formatAttachError(
      new SleeperApiError('not found', 404, '/draft/999999999999999999'),
    );
    expect(message).toContain('draft');
    // The old wording blamed a username, which is not what was pasted.
    expect(message).not.toContain('username');
  });
});

describe('only the newest attach may write its result', () => {
  it('does not let a slower league attach overwrite a mock attached afterwards', async () => {
    // The reported bug: the league needs a second round trip, so an attach
    // started FIRST lands LAST.
    const { client } = fakeClient([leagueDraft(LEAGUE_DRAFT_ID), mockDraft()], {
      leagueDelayMs: 30,
    });
    const sequence = createAttachSequence();
    const written: string[] = [];

    const attach = async (draftId: string) => {
      const isCurrent = sequence.begin();
      const resolved = await resolveDraftAttachment(client, draftId);
      if (!isCurrent()) return;
      written.push(resolved.draftId);
    };

    const stale = attach(LEAGUE_DRAFT_ID);
    const latest = attach(MOCK_ID);
    await Promise.all([stale, latest]);

    expect(written).toEqual([MOCK_ID]);
  });

  it('drops an in-flight attach once the user has detached', async () => {
    const { client } = fakeClient([leagueDraft(LEAGUE_DRAFT_ID)], { leagueDelayMs: 10 });
    const sequence = createAttachSequence();
    let written: string | null = null;

    const isCurrent = sequence.begin();
    const inFlight = resolveDraftAttachment(client, LEAGUE_DRAFT_ID).then((resolved) => {
      if (isCurrent()) written = resolved.draftId;
    });

    sequence.cancel();
    await inFlight;

    expect(written).toBeNull();
  });
});
