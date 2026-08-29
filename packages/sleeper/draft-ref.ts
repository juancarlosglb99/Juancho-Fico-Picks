/**
 * Turning whatever a user pastes into a Sleeper draft id.
 *
 * Sleeper mock drafts are not attached to a league, so they never appear in
 * `/user/{id}/leagues`. The only reliable way to reach one is its draft id,
 * which a user gets from the draft-room URL. This module accepts every shape
 * that URL realistically arrives in, plus a bare id.
 *
 * Pure functions: no network, no DOM.
 */

/** Sleeper ids are large numeric snowflakes. */
const ID_PATTERN = /^\d{6,25}$/;

/** `/draft/<sport>/<id>` anywhere in a string, which covers every draft URL shape. */
const DRAFT_PATH_PATTERN = /\/draft\/[a-z]+\/(\d{6,25})/i;

const SLEEPER_HOSTS = new Set([
  'sleeper.com',
  'www.sleeper.com',
  'sleeper.app',
  'www.sleeper.app',
  'api.sleeper.app',
]);

export type DraftRefKind = 'id' | 'url';

export interface SleeperDraftRef {
  draftId: string;
  /** How the id was supplied, so the UI can echo it back accurately. */
  kind: DraftRefKind;
}

export type DraftRefFailure =
  | 'empty'
  | 'not_sleeper_host'
  | 'no_draft_id';

export type ParseDraftRefResult =
  | { ok: true; ref: SleeperDraftRef }
  | { ok: false; reason: DraftRefFailure; message: string };

const FAILURE_MESSAGES: Record<DraftRefFailure, string> = {
  empty: 'Paste a Sleeper draft link or draft ID.',
  not_sleeper_host:
    'That link is not a Sleeper URL. Open your draft room and copy the address, or paste the draft ID on its own.',
  no_draft_id:
    'No draft ID found in that value. A draft link looks like https://sleeper.com/draft/nfl/1234567890123456789.',
};

function failure(reason: DraftRefFailure): ParseDraftRefResult {
  return { ok: false, reason, message: FAILURE_MESSAGES[reason] };
}

/**
 * Accepts, in order of preference:
 *   - a bare draft id                         1234567890123456789
 *   - a draft-room URL                        https://sleeper.com/draft/nfl/1234567890123456789
 *   - the same URL with extra path or query   .../draft/nfl/<id>/board?foo=1
 *   - a URL without a scheme                  sleeper.com/draft/nfl/<id>
 *   - a `draft_id=` query parameter           https://sleeper.com/anything?draft_id=<id>
 */
export function parseSleeperDraftRef(input: string): ParseDraftRefResult {
  const trimmed = input.trim();
  if (!trimmed) return failure('empty');

  if (ID_PATTERN.test(trimmed)) {
    return { ok: true, ref: { draftId: trimmed, kind: 'id' } };
  }

  const looksLikeUrl = /[./]/.test(trimmed);
  if (!looksLikeUrl) return failure('no_draft_id');

  // A pasted URL may or may not carry its scheme; URL() insists on one.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return failure('no_draft_id');
  }

  if (!SLEEPER_HOSTS.has(url.hostname.toLowerCase())) {
    return failure('not_sleeper_host');
  }

  const fromPath = DRAFT_PATH_PATTERN.exec(url.pathname);
  if (fromPath) {
    return { ok: true, ref: { draftId: fromPath[1], kind: 'url' } };
  }

  const fromQuery = url.searchParams.get('draft_id');
  if (fromQuery && ID_PATTERN.test(fromQuery.trim())) {
    return { ok: true, ref: { draftId: fromQuery.trim(), kind: 'url' } };
  }

  return failure('no_draft_id');
}

/** Convenience wrapper for callers that only care about the id. */
export function extractSleeperDraftId(input: string): string | null {
  const result = parseSleeperDraftRef(input);
  return result.ok ? result.ref.draftId : null;
}

/** The canonical draft-room URL for a draft id, for display and copy buttons. */
export function sleeperDraftUrl(draftId: string, sport = 'nfl'): string {
  return `https://sleeper.com/draft/${sport}/${draftId}`;
}
