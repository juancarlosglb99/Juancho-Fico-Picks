import { FirstSeedProjectionProvider } from '@/packages/first-seed/providers';
import type { ScoringProfile } from '@/packages/engine/context/types';

const FORMATS = new Set<ScoringProfile>(['standard', 'half_ppr', 'full_ppr']);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const season = url.searchParams.get('season') ?? '';
  const scoringFormat = url.searchParams.get('format') as ScoringProfile | null;
  if (!/^20\d{2}$/.test(season) || !scoringFormat || !FORMATS.has(scoringFormat)) {
    return Response.json({ error: 'Invalid First Seed projection request.' }, { status: 400 });
  }
  try {
    const snapshot = await new FirstSeedProjectionProvider().getSnapshot({
      season,
      scoringFormat,
    });
    return Response.json(snapshot, {
      headers: {
        'Cache-Control': 'public, max-age=3600, s-maxage=43200, stale-while-revalidate=345600',
      },
    });
  } catch {
    return Response.json({ error: 'First Seed projections are temporarily unavailable.' }, { status: 502 });
  }
}
