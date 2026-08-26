import { describe, expect, it } from 'vitest';
import {
  extractSleeperDraftId,
  parseSleeperDraftRef,
  sleeperDraftUrl,
} from '../../packages/sleeper/draft-ref';

const DRAFT_ID = '1234567890123456789';

describe('parseSleeperDraftRef', () => {
  it('accepts a bare draft id', () => {
    const result = parseSleeperDraftRef(DRAFT_ID);
    expect(result).toEqual({ ok: true, ref: { draftId: DRAFT_ID, kind: 'id' } });
  });

  it('trims surrounding whitespace', () => {
    const result = parseSleeperDraftRef(`  ${DRAFT_ID}\n`);
    expect(result.ok && result.ref.draftId).toBe(DRAFT_ID);
  });

  it('accepts the draft-room URL a user copies from the address bar', () => {
    const result = parseSleeperDraftRef(`https://sleeper.com/draft/nfl/${DRAFT_ID}`);
    expect(result.ok && result.ref).toEqual({ draftId: DRAFT_ID, kind: 'url' });
  });

  it('accepts the legacy sleeper.app domain', () => {
    const result = parseSleeperDraftRef(`https://sleeper.app/draft/nfl/${DRAFT_ID}`);
    expect(result.ok && result.ref.draftId).toBe(DRAFT_ID);
  });

  it('accepts a URL with extra path segments and a query string', () => {
    const result = parseSleeperDraftRef(
      `https://sleeper.com/draft/nfl/${DRAFT_ID}/board?tab=order`,
    );
    expect(result.ok && result.ref.draftId).toBe(DRAFT_ID);
  });

  it('accepts a URL pasted without its scheme', () => {
    const result = parseSleeperDraftRef(`sleeper.com/draft/nfl/${DRAFT_ID}`);
    expect(result.ok && result.ref.draftId).toBe(DRAFT_ID);
  });

  it('accepts a draft_id query parameter', () => {
    const result = parseSleeperDraftRef(
      `https://sleeper.com/leagues/999?draft_id=${DRAFT_ID}`,
    );
    expect(result.ok && result.ref.draftId).toBe(DRAFT_ID);
  });

  it('handles non-nfl sports in the path', () => {
    const result = parseSleeperDraftRef(`https://sleeper.com/draft/nba/${DRAFT_ID}`);
    expect(result.ok && result.ref.draftId).toBe(DRAFT_ID);
  });

  it('rejects an empty value with a helpful message', () => {
    const result = parseSleeperDraftRef('   ');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('empty');
    expect(!result.ok && result.message).toMatch(/paste a sleeper draft link/i);
  });

  it('rejects a link to a different site', () => {
    const result = parseSleeperDraftRef(`https://example.com/draft/nfl/${DRAFT_ID}`);
    expect(!result.ok && result.reason).toBe('not_sleeper_host');
  });

  it('rejects a Sleeper URL that is not a draft', () => {
    const result = parseSleeperDraftRef('https://sleeper.com/leagues/123456/team');
    expect(!result.ok && result.reason).toBe('no_draft_id');
  });

  it('rejects free text', () => {
    expect(parseSleeperDraftRef('my mock draft').ok).toBe(false);
  });

  it('rejects a number that is too short to be a Sleeper id', () => {
    expect(parseSleeperDraftRef('12345').ok).toBe(false);
  });
});

describe('extractSleeperDraftId', () => {
  it('returns the id or null', () => {
    expect(extractSleeperDraftId(`https://sleeper.com/draft/nfl/${DRAFT_ID}`)).toBe(
      DRAFT_ID,
    );
    expect(extractSleeperDraftId('nope')).toBeNull();
  });
});

describe('sleeperDraftUrl', () => {
  it('round-trips with the parser', () => {
    const url = sleeperDraftUrl(DRAFT_ID);
    expect(url).toBe(`https://sleeper.com/draft/nfl/${DRAFT_ID}`);
    expect(extractSleeperDraftId(url)).toBe(DRAFT_ID);
  });
});
