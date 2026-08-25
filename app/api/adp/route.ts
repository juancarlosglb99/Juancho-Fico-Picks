import { FantasyFootballCalculatorAdpProvider } from '@/packages/adp/providers/fantasy-football-calculator';
import type { AdpProviderRequest } from '@/packages/data/types';

const FORMATS = new Set<AdpProviderRequest['format']>([
  'standard',
  'half-ppr',
  'ppr',
  '2qb',
]);
const TEAM_COUNTS = new Set([8, 10, 12, 14]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const format = url.searchParams.get('format') as AdpProviderRequest['format'] | null;
  const teams = Number(url.searchParams.get('teams'));
  const season = url.searchParams.get('season') ?? '';
  if (
    !format ||
    !FORMATS.has(format) ||
    !TEAM_COUNTS.has(teams) ||
    !/^20\d{2}$/.test(season)
  ) {
    return Response.json({ error: 'Invalid ADP request.' }, { status: 400 });
  }

  try {
    const provider = new FantasyFootballCalculatorAdpProvider();
    const snapshot = await provider.getSnapshot({ format, teams, season });
    return Response.json(snapshot, {
      headers: {
        'Cache-Control': 'public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400',
      },
    });
  } catch {
    return Response.json(
      { error: 'The automatic ADP source is temporarily unavailable.' },
      { status: 502 },
    );
  }
}
