/**
 * The verification screen. Its job is to fail LOUDLY before a draft rather than
 * quietly during one, so most of these assert on the blocking classification.
 */
import { describe, expect, it } from 'vitest';
import { buildDraftReadiness } from '../../packages/ui/readiness';
import { buildDraftAttachment } from '../../packages/sleeper/attachment';
import { makeLeague, makeRosters } from '../engine/fixtures';
import type { ProjectionSnapshot } from '../../packages/data/types';
import { scenario } from './scenario';

const state = scenario({ picksMade: 0 });
const attachment = buildDraftAttachment({
  draft: state.draft,
  league: makeLeague({ teams: 12 }),
  rosters: makeRosters(12),
});

function projections(overrides: Partial<ProjectionSnapshot> = {}): ProjectionSnapshot {
  return {
    kind: 'projection',
    provenance: {
      sourceId: 'first-seed',
      sourceLabel: 'First Seed JuiceSheets',
      season: '2026',
      fetchedAt: new Date().toISOString(),
      sourceUpdatedAt: null,
      sourceConfidence: 'high',
    },
    filename: 'juicesheets.csv',
    scoringFormat: 'standard',
    records: [],
    unmatched: [],
    resolution: {
      total: 400,
      matched: 396,
      directExternalId: 396,
      exactCanonical: 0,
      normalizedName: 0,
      ambiguous: 0,
      unresolved: 4,
    },
    completeStatLines: 0,
    ...overrides,
  };
}

function readiness({
  projectionSnapshot = projections(),
  ai = { configured: true, accountsEnabled: false, plan: 'basic' as const, creditsRemaining: null },
}: {
  projectionSnapshot?: ProjectionSnapshot | null;
  ai?: Parameters<typeof buildDraftReadiness>[0]['ai'];
} = {}) {
  return buildDraftReadiness({
    attachment,
    draft: state.draft,
    context: state.context,
    projections: projectionSnapshot,
    roomRankings: null,
    adp: null,
    ourTeamName: 'Juancho',
    ai,
  });
}

describe('pre-draft verification', () => {
  it('describes the league in the terms the drafter chose it by', () => {
    const model = readiness();
    expect(model.league.teams).toBe(12);
    expect(model.league.rosterSummary).toContain('QB');
    expect(model.league.rosterSummary).toContain('FLEX');
    expect(model.league.draftType).toBe('Snake');
    expect(model.league.scoring).toBeTruthy();
  });

  it('names our seat, which is the most damaging thing to get wrong', () => {
    const model = readiness();
    expect(model.us.draftSlot).toBe(3);
    expect(model.us.teamName).toBe('Juancho');
    const seat = model.checks.find((check) => check.id === 'seat')!;
    expect(seat.status).toBe('ok');
    expect(seat.blocking).toBe(true);
  });

  it('is ready when everything the recommendation needs is present', () => {
    const model = readiness();
    expect(model.ready).toBe(true);
    expect(model.blockers).toEqual([]);
  });

  it('is not ready, and says why, without a projection source', () => {
    const model = readiness({ projectionSnapshot: null });
    expect(model.ready).toBe(false);
    expect(model.blockers.map((check) => check.id)).toEqual(['projections']);
    expect(model.blockers[0].detail).toContain('CSV');
  });

  it('warns rather than blocks when a source is merely degraded', () => {
    const model = readiness({
      projectionSnapshot: projections({
        resolution: {
          total: 400,
          matched: 200,
          directExternalId: 200,
          exactCanonical: 0,
          normalizedName: 0,
          ambiguous: 0,
          unresolved: 200,
        },
      }),
    });
    const check = model.checks.find((entry) => entry.id === 'projections')!;
    expect(check.status).toBe('warn');
    expect(model.ready).toBe(true);
  });

  it('treats a missing draft-room board as a warning, because the engine says so', () => {
    const model = readiness();
    const check = model.checks.find((entry) => entry.id === 'room_rankings')!;
    expect(check.status).toBe('missing');
    expect(check.blocking).toBe(false);
    expect(model.ready).toBe(true);
  });

  it('reports the AI as unavailable without ever blocking the draft on it', () => {
    const off = readiness({
      ai: { configured: false, accountsEnabled: false, plan: 'basic', creditsRemaining: null },
    });
    const check = off.checks.find((entry) => entry.id === 'ai')!;
    expect(check.value).toBe('Not configured');
    expect(check.blocking).toBe(false);
    expect(off.ready).toBe(true);

    const unknown = readiness({
      ai: { configured: null, accountsEnabled: false, plan: 'basic', creditsRemaining: null },
    });
    expect(unknown.checks.find((entry) => entry.id === 'ai')!.status).toBe('unknown');
  });

  it('separates "this server has no key" from "your plan does not include it"', () => {
    const aiCheck = (ai: Parameters<typeof buildDraftReadiness>[0]['ai']) =>
      readiness({ ai }).checks.find((entry) => entry.id === 'ai')!;

    // A Basic user on a perfectly healthy server is not a broken deployment.
    const basic = aiCheck({ configured: true, accountsEnabled: true, plan: 'basic', creditsRemaining: 0 });
    expect(basic.value).toBe('Pro feature');
    expect(basic.detail).toContain('Everything else is unaffected');

    const spent = aiCheck({ configured: true, accountsEnabled: true, plan: 'pro', creditsRemaining: 0 });
    expect(spent.value).toBe('No credits left');

    const ready = aiCheck({ configured: true, accountsEnabled: true, plan: 'pro', creditsRemaining: 3 });
    expect(ready).toMatchObject({ status: 'ok', value: '3 drafts left' });
    expect(aiCheck({ configured: true, accountsEnabled: true, plan: 'pro', creditsRemaining: 1 }).value)
      .toBe('1 draft left');

    const admin = aiCheck({ configured: true, accountsEnabled: true, plan: 'admin', creditsRemaining: null });
    expect(admin).toMatchObject({ status: 'ok', value: 'Unlimited' });

    // None of them ever blocks.
    for (const check of [basic, spent, ready, admin]) expect(check.blocking).toBe(false);
  });
});
