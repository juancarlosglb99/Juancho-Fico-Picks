import type { DraftRoomPlatform } from '@/packages/data/types';
import type { ScoringProfile } from '@/packages/engine/context/types';
import { FirstSeedDraftRoomRankingProvider } from '@/packages/first-seed/providers';

const PLATFORMS = new Set<DraftRoomPlatform>(['sleeper', 'espn', 'yahoo', 'cbs']);
const FORMATS = new Set<ScoringProfile>(['standard', 'half_ppr', 'full_ppr']);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const season = url.searchParams.get('season') ?? '';
  const platform = url.searchParams.get('platform') as DraftRoomPlatform | null;
  const scoringFormat = url.searchParams.get('format') as ScoringProfile | null;
  const qbFormat = url.searchParams.get('qb');
  if (
    !/^20\d{2}$/.test(season) || !platform || !PLATFORMS.has(platform) ||
    !scoringFormat || !FORMATS.has(scoringFormat) ||
    (qbFormat !== '1qb' && qbFormat !== 'superflex')
  ) {
    return Response.json({ error: 'Invalid First Seed room-ranking request.' }, { status: 400 });
  }
  try {
    const snapshot = await new FirstSeedDraftRoomRankingProvider().getSnapshot({
      season,
      platform,
      scoringFormat,
      qbFormat,
    });
    return Response.json(snapshot, {
      headers: {
        'Cache-Control': 'public, max-age=3600, s-maxage=43200, stale-while-revalidate=345600',
      },
    });
  } catch {
    return Response.json({ error: 'First Seed room rankings are temporarily unavailable.' }, { status: 502 });
  }
}
