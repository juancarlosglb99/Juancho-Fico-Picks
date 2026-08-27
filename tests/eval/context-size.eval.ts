/**
 * Where the prompt's tokens actually go.
 *
 *     npm run strategist:size
 *
 * Measured before anything is cut. A section that looks verbose in the source
 * is not necessarily expensive, and the sections that are expensive are not
 * always the ones that look it - cutting on impression rather than measurement
 * is how you lose information and save nothing.
 *
 * Token counts come from the API's own counter rather than a characters-per-
 * token estimate. Per-section counts are measured by counting each section
 * alone, so they will not sum exactly to the whole: the enclosing JSON adds
 * punctuation and the tokenizer merges differently at the seams. The total row
 * is the authoritative one.
 */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { buildBriefAtPick } from '../../packages/engine/benchmark/brief-replay';
import {
  listCases,
  readProjectionSnapshot,
  readRoomSnapshot,
} from '../../packages/engine/benchmark/store';
import {
  resolveStrategistModel,
} from '../../packages/engine/strategist/anthropic/client';
import { STRATEGIST_SYSTEM_PROMPT } from '../../packages/engine/strategist/anthropic/playbook';
import { recommendationTool } from '../../packages/engine/strategist/anthropic/schema';
import { buildStrategistPromptContext } from '../../packages/engine/strategist/prompt-context';
import { buildDraftAttachment } from '../../packages/sleeper/attachment';
import { draftFor, playersFor } from '../regression/replay-harness';

const DRAFT_ID = process.env.JUANCHO_SIZE_DRAFT ?? '1398448522730221568';
const PICK = Number(process.env.JUANCHO_SIZE_PICK ?? 52);

describe('prompt size', () => {
  it('breaks the payload down by section', async () => {
    const entry = listCases().find((item) => item.draftId === DRAFT_ID)!;
    const draft = draftFor(entry);
    const attachment = buildDraftAttachment({ draft, league: null, rosters: null });
    const brief = buildBriefAtPick(
      {
        regression: entry,
        projections: readProjectionSnapshot(entry.projectionsRef),
        roomRankings: entry.roomRankingsRef ? readRoomSnapshot(entry.roomRankingsRef) : null,
        players: playersFor(entry),
        league: attachment.league,
        draft,
        rosters: attachment.rosters,
      },
      PICK,
    )!;

    const context = buildStrategistPromptContext(brief, { blind: true });
    const model = resolveStrategistModel();
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const tool = recommendationTool(true);

    const count = async (text: string) => {
      const result = await client.messages.countTokens({
        model,
        messages: [{ role: 'user', content: text }],
      });
      return result.input_tokens;
    };

    const userMessage = `Current draft state:\n\n${JSON.stringify(context)}`;
    const whole = await client.messages.countTokens({
      model,
      system: STRATEGIST_SYSTEM_PROMPT,
      tools: [tool],
      messages: [{ role: 'user', content: userMessage }],
    });

    const rows: { section: string; bytes: number; tokens: number }[] = [];
    rows.push({
      section: 'system playbook',
      bytes: STRATEGIST_SYSTEM_PROMPT.length,
      tokens: await count(STRATEGIST_SYSTEM_PROMPT),
    });
    rows.push({
      section: 'tool schema',
      bytes: JSON.stringify(tool).length,
      tokens: await count(JSON.stringify(tool)),
    });

    /* Each section of the context, measured on its own. */
    const sections: [string, unknown][] = [
      ['pick + league', { pick: context.pick, league: context.league }],
      ['us', context.us],
      ['opponents', context.opponents],
      ['upcoming', context.upcoming],
      ['room: recent picks', context.room.recent],
      ['room: tier cliffs', context.room.tierCliffs],
      ['room: rest', {
        totalDrafted: context.room.totalDrafted,
        tendency: context.room.tendency,
        positionShare: context.room.positionShare,
        runs: context.room.runs,
        recentPositionCounts: context.room.recentPositionCounts,
      }],
      ['board: legend', context.board.legend],
      ['board: rows', context.board.rows],
      ['joint: legends', {
        pairs: context.jointAvailability?.pairs.legend,
        tiers: context.jointAvailability?.tiers.legend,
        nextPickBoard: context.jointAvailability?.nextPickBoard.legend,
        fallbacks: context.jointAvailability?.fallbacks.legend,
      }],
      ['joint: rows', {
        pairs: context.jointAvailability?.pairs.rows,
        tiers: context.jointAvailability?.tiers.rows,
        nextPickBoard: context.jointAvailability?.nextPickBoard.rows,
        fallbacks: context.jointAvailability?.fallbacks.rows,
      }],
      ['simulation evidence', context.simulation],
      ['dataWarnings', context.dataWarnings],
      ['rules', context.rules],
      ['omitted notes', context.omitted],
    ];
    for (const [section, value] of sections) {
      const json = JSON.stringify(value ?? null);
      rows.push({ section, bytes: json.length, tokens: await count(json) });
    }

    const contextTokens = await count(userMessage);
    console.log(
      `\n[size] ${DRAFT_ID} pick ${PICK} · blind context · concise contract · model ${model}`,
    );
    console.log(`[size] WHOLE REQUEST: ${whole.input_tokens} input tokens\n`);
    console.log(`  ${'section'.padEnd(22)} ${'bytes'.padStart(8)} ${'tokens'.padStart(8)}   share`);
    const sumParts = rows.reduce((total, row) => total + row.tokens, 0);
    for (const row of [...rows].sort((a, b) => b.tokens - a.tokens)) {
      console.log(
        `  ${row.section.padEnd(22)} ${String(row.bytes).padStart(8)} ${String(row.tokens).padStart(8)}   ` +
          `${((row.tokens / sumParts) * 100).toFixed(1).padStart(5)}%`,
      );
    }
    console.log(
      `\n  ${'sum of parts'.padEnd(22)} ${''.padStart(8)} ${String(sumParts).padStart(8)}`,
    );
    console.log(
      `  ${'context alone'.padEnd(22)} ${String(JSON.stringify(context).length).padStart(8)} ${String(contextTokens).padStart(8)}`,
    );
    console.log(
      `  ${'whole request'.padEnd(22)} ${''.padStart(8)} ${String(whole.input_tokens).padStart(8)}`,
    );
    expect(whole.input_tokens).toBeGreaterThan(0);
  });
});
