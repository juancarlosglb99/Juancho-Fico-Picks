/**
 * The runner behind `npm run capture`.
 *
 * Vitest is used purely as the TypeScript execution environment - the project
 * has no separate script runner, and adding one for this would be a dependency
 * that earns nothing.
 *
 *     npm run capture -- https://sleeper.com/draft/nfl/123... yourusername
 */
import { describe, expect, it } from 'vitest';
import { captureMock } from '../../scripts/capture-mock';

const [draftRef, username] = (process.env.CAPTURE_ARGS ?? '').split(/\s+/).filter(Boolean);

describe('capture a mock draft', () => {
  it('writes a permanent regression case', async () => {
    if (!draftRef || !username) {
      throw new Error(
        'Usage: npm run capture -- "<draft link or id>" "<sleeper username>"',
      );
    }
    const { path, regression } = await captureMock(draftRef, username);
    const quality = regression.baseline.quality;

    console.log(`\n[capture] saved ${path}`);
    console.log(
      `[capture] ${regression.format.teams}-team ${regression.format.scoringProfile} ` +
        `${regression.format.qbFormat} ${regression.format.draftType}` +
        `${regression.format.isMock ? ' mock' : ''}, seat ${regression.userSlot}, ` +
        `${regression.format.rounds} rounds`,
    );
    console.log(
      `[capture] you drafted: ${summarize(regression.actualRoster.map((entry) => entry.position))}`,
    );
    console.log(
      `[capture] engine would draft: ${summarize(regression.baseline.finalRoster.map((entry) => entry.position))}`,
    );
    console.log(
      `[capture] baseline quality: starting=${quality.startingValue} bench=${quality.benchValue} ` +
        `unfilled=${quality.unfilledSlots} unusable=${quality.unusableDepth} ` +
        `meanRegret=${quality.meanRegret}`,
    );

    expect(regression.picks.length).toBeGreaterThan(0);
    expect(regression.baseline.decisions.length).toBeGreaterThan(0);
  }, 600_000);
});

function summarize(positions: string[]): string {
  const counts = new Map<string, number>();
  for (const position of positions) counts.set(position, (counts.get(position) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([position, count]) => `${position}${count}`)
    .join(' ');
}
