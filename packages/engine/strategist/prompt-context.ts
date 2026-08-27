/**
 * The brief, compressed for a model rather than for an auditor.
 *
 * `DraftBrief` is the canonical record and stays exactly as it is: a hundred
 * kilobytes of it is the right price for being able to re-examine a
 * questionable pick weeks later. Sending all of it on every decision is not.
 *
 * Measured on a real mock, the weight was never the information - it was the
 * JSON. Fifty-five kilobytes of candidates carried 290 bytes of repeated keys
 * per player against a handful of small numbers, and the opponents section
 * described the same players four separate times: once as a roster, once as a
 * pick list, once as a starting lineup and once as a bench. So this compresses
 * by removing REPETITION, not by removing facts:
 *
 *   - the candidate pool becomes a table, with column names written once
 *   - each roster becomes one round-prefixed line instead of four structures
 *   - anything derivable from something else already present is dropped
 *   - anything that exists purely for auditing is dropped
 *
 * The result carries every decision-relevant field the brief does. What it
 * drops is listed in `omitted`, so the claim is checkable rather than asserted.
 */
import type { Position } from '../../players/types';
import type {
  BriefCandidate,
  BriefPositionNeed,
  BriefTeam,
  DraftBrief,
  PlayerNewsItem,
  StrategyContext,
} from './types';

export const PROMPT_CONTEXT_VERSION = 1;

/**
 * A table: column names once, then one row per entry.
 *
 * The whole compression is this. A model reads a labelled table at least as
 * well as it reads nested objects, and a draft board is a table anyway.
 */
export interface CompactTable {
  columns: string[];
  /** What each column means, since the names are abbreviated to save room. */
  legend: Record<string, string>;
  rows: (string | number | null)[][];
}

export interface CompactTeam {
  /** Roster id, which is how the upcoming pick order refers to teams. */
  id: number;
  slot: number | null;
  name: string | null;
  /** Every player they hold, round-prefixed and in draft order. */
  roster: string;
  counts: string;
  /** Starting slots they cannot fill yet. */
  holes: string;
  /** Only positions with a real need; a satisfied position is not listed. */
  needs: string;
  build: string;
  /** Positions they have taken meaningfully before First Seed's board said to. */
  reachesAt: string | null;
  /** Their most recent selections, newest last. */
  recent: string;
  nextPick: number | null;
}

export interface OurTeamContext extends CompactTeam {
  /** Every starting slot and who occupies it, so gaps are unambiguous. */
  lineup: string;
  bench: string;
  /** Full per-position detail: we are drafting for this roster, not modelling it. */
  positions: {
    position: Position;
    drafted: number;
    starters: string;
    open: number;
    need: string;
    saturation: string;
    quality: string;
  }[];
}

export interface StrategistPromptContext {
  contextVersion: number;

  pick: {
    overall: number;
    round: number;
    ourSlot: number | null;
    onTheClock: boolean;
    nextOurPick: number | null;
    picksUntilOurNextTurn: number | null;
    selectionsWeStillOwn: number[];
  };

  league: {
    teams: number;
    rounds: number;
    scoring: string;
    qbFormat: string;
    /** Starting lineup, written as slots rather than a count per position. */
    starters: string;
    bench: number;
    type: string;
  };

  us: OurTeamContext;
  opponents: CompactTeam[];

  /** Who selects between now and our next turn, in the order they do it. */
  upcoming: {
    /** `[overallPick, rosterId]`, earliest first. */
    order: [number, number | null][];
    /** Their needs, once each, keyed by roster id. */
    needs: Record<string, string>;
  };

  room: {
    totalDrafted: number;
    tendency: string;
    positionShare: Record<string, number>;
    /** Positions currently going faster than a normal room takes them. */
    runs: string[];
    recentPositionCounts: Record<string, number>;
    recent: CompactTable;
    tierCliffs: CompactTable;
  };

  /** Every available player the strategist may choose from. */
  board: CompactTable;

  /**
   * Players whose First Seed rank and projection point different ways.
   *
   * Informational and rare. Nothing has been altered or excluded - the two
   * published numbers simply disagree, usually because they were produced on
   * different bases, and treating them as though they agreed is how a player
   * projecting a quarter of his rank neighbours gets taken on his rank alone.
   */
  dataWarnings: {
    playerId: string;
    name: string;
    position: Position;
    code: string;
    detail: string;
  }[];

  /**
   * The rest of the board, in fewer columns.
   *
   * Present only in compact mode. Every remaining available player, with enough
   * to know he exists and roughly what he is worth - so a correct pick can
   * never vanish because it fell outside an arbitrary top-N, without paying
   * twenty metrics for a player nobody would take.
   */
  deepBoard?: CompactTable;

  /**
   * Availability for more than one player at a time.
   *
   * The board's `surv` column is marginal: it says whether ONE player reaches
   * us. Questions like "will either of these two tight ends be there" are not
   * answerable from it, and multiplying the two would assume an independence
   * the draft does not have - a room that spends a pick on one has one fewer
   * pick for the other. Every figure here is counted from the same simulated
   * futures the marginals come from.
   */
  jointAvailability: {
    runs: number;
    interveningSelections: number;
    pairs: CompactTable;
    tiers: CompactTable;
    nextPickBoard: CompactTable;
    fallbacks: CompactTable;
  } | null;

  /**
   * The deterministic engine's conclusion. Absent in blind mode.
   *
   * Its evidence is spread through the board and the simulation block either
   * way; this is only the verdict.
   */
  juancho?: {
    recommended: { playerId: string; name: string; position: Position; action: string } | null;
    firstSeedBestAvailable: { playerId: string; name: string; rank: number } | null;
    /** Absolute final-roster value of the recommended pick, so deltas have scale. */
    recommendedPlanValue: number | null;
    top: CompactTable;
  };

  /**
   * Simulation evidence with no verdict attached. Present in blind mode.
   *
   * `simGap` on the board is measured from the best final roster any candidate
   * produces, which is a property of the simulation rather than of anyone's
   * preference - unlike the deltas used elsewhere, which are measured from the
   * recommended pick and therefore identify it.
   */
  simulation?: {
    /** The highest completed-roster value any candidate reaches, for scale. */
    bestFinalRosterValue: number | null;
    /** First Seed's own best available player - their signal, not ours. */
    firstSeedBestAvailable: { playerId: string; name: string; rank: number } | null;
  };

  rules: {
    selectionsRemaining: number;
    kickersAndDefensesAllowed: boolean;
    /** Positions that cannot be selected right now, and why. */
    blocked: string[];
    /** Bodies at a position that could ever reach our lineup. */
    usableCapacity: Record<string, number>;
    mustFillBeforeDraftEnds: string;
    /** Stated plainly, because a model that is told the rules obeys them more. */
    mustReturn: string[];
  };

  strategyContext: StrategyContext | null;
  playerNews: PlayerNewsItem[] | null;

  /** What was left out of the brief, and why. Checkable, not asserted. */
  omitted: string[];
}

export interface PromptContextOptions {
  /** Candidates carried on the board. Null keeps every one the brief holds. */
  maxCandidates: number | null;
  /** How far down Juancho's own ranking to report. */
  deterministicDepth: number;
  /** Selections carried in the room's recent history. */
  recentPicks: number;
  /** Each opponent's last few selections, for reading their direction. */
  opponentRecentPicks: number;
  /**
   * Withhold the deterministic engine's CONCLUSION while keeping its evidence.
   *
   * The strategist exists to arbitrate the draft state independently, and it
   * cannot do that while being shown the answer first. Benchmarking Sonnet made
   * the problem concrete: it agreed with the engine on five decisions out of
   * five and cited "Juancho ranks this first" as a reason, which turns an
   * independent recommender into a ratifier of what we already computed.
   *
   * What is removed is only the verdict - the named pick, the ranked list, the
   * per-candidate recommendation rank and action label, and the penalty-adjusted
   * ordering that produces them. Everything the verdict was DERIVED from stays:
   * First Seed's rank and projection, tiers, survival, joint availability,
   * opponent rosters, roster utility, the completed-roster simulation and the
   * anomaly warnings.
   *
   * The engine's recommendation still exists outside the prompt, as the
   * fallback and the guardrail.
   */
  blind: boolean;
  /**
   * Spend detail where the decision needs it.
   *
   * Measured before cutting: the candidate board is a third of the prompt and
   * the opponents another tenth, while the sections that LOOK verbose - rules,
   * tier cliffs, the simulation block - are under two percent between them.
   * Cutting on impression rather than measurement loses information and saves
   * nothing.
   *
   * So nothing is truncated by rank. The board keeps full metrics for the
   * players a decision could turn on and a thinner row for everyone else, so
   * the model still knows what exists deeper without paying twenty columns for
   * a player nobody would take. Opponents keep full rosters where they bear on
   * this pick and a summary where they do not.
   */
  compact: boolean;
}

export const DEFAULT_PROMPT_CONTEXT: PromptContextOptions = {
  maxCandidates: null,
  deterministicDepth: 10,
  recentPicks: 15,
  opponentRecentPicks: 4,
  blind: false,
  compact: false,
};

/** In compact mode: how much of First Seed's board keeps full metrics. */
const RICH_TOP_BOARD = 20;
/** Plus the best few at each position we can still start. */
const RICH_PER_OPEN_POSITION = 6;
/** Plus the leaders on the completed-roster simulation. */
const RICH_SIMULATION_LEADERS = 10;
/** Plus the top of each tier that could break, bounded against a flat curve. */
const RICH_PER_TIER = 8;

const BOARD_LEGEND: Record<string, string> = {
  id: 'player id - return this exact string to select him',
  name: 'player name',
  pos: 'position',
  tm: 'NFL team',
  fsRank: "First Seed's rank on their Sleeper board for this format",
  fsGap: "ranks past First Seed's best available player this pick reaches",
  fsVal: "First Seed's value delta; negative means they rate him below market",
  fsMine: "First Seed's landmine score; higher means more bust risk",
  proj: 'projected points, recalculated for this league scoring',
  tier: "Juancho's tier of First Seed's projections at this position",
  left: 'players remaining in that tier',
  surv: '% chance he is still available at our next selection',
  conf: 'confidence in that survival estimate',
  jRank: "Juancho's projection rank across the whole pool",
  projRank: 'rank by projected points across the whole available pool',
  simGap:
    'final-roster points below the best completed roster any candidate on this ' +
    'board produces - a simulation result, measured from the best outcome rather ' +
    'than from any preferred pick',
  posRank: 'rank within his own position',
  jRec: "position in Juancho's ranked recommendations; blank means unranked",
  act: 'DRAFT_NOW or WAIT',
  dPlan: "final-roster points versus Juancho's own pick, raw simulation",
  dDec: 'same comparison after the reaching and stacking penalties are charged',
  gain: 'points added to our roster the moment we take him',
  age: 'age',
  note: 'anything unusual about his status',
  warn: "set when First Seed's own rank and projection disagree about him - see dataWarnings",
};

export function buildStrategistPromptContext(
  brief: DraftBrief,
  options: Partial<PromptContextOptions> = {},
): StrategistPromptContext {
  const opts = { ...DEFAULT_PROMPT_CONTEXT, ...options };

  const recommended = brief.deterministic.recommended;
  const recommendedPlan =
    brief.candidates.find((candidate) => candidate.playerId === recommended?.playerId)?.juancho
      .planValue ?? null;

  // Everything reported under `juancho.top` is quoted in two places, so it must
  // survive any trimming of the board it is quoted from.
  const reported = brief.deterministic.top.slice(0, Math.max(0, opts.deterministicDepth));
  const protectedIds = new Set(reported.map((entry) => entry.playerId));
  if (recommended) protectedIds.add(recommended.playerId);

  const candidates =
    opts.maxCandidates === null
      ? brief.candidates
      : keepBest(brief.candidates, opts.maxCandidates, protectedIds);

  /*
   * The reference the blind board measures from: the best completed roster any
   * candidate produces. A simulation result, not a preference - unlike the
   * recommended pick's value, which is only special because it was chosen.
   */
  const bestFinalRosterValue = brief.candidates.reduce<number | null>(
    (best, candidate) =>
      candidate.juancho.planValue === null
        ? best
        : best === null
          ? candidate.juancho.planValue
          : Math.max(best, candidate.juancho.planValue),
    null,
  );
  const firstSeedBest = brief.deterministic.bestAvailableFirstSeed
    ? {
        playerId: brief.deterministic.bestAvailableFirstSeed.playerId,
        name: brief.deterministic.bestAvailableFirstSeed.name,
        rank: brief.deterministic.bestAvailableFirstSeed.rank,
      }
    : null;

  /*
   * Who gets full metrics.
   *
   * A union of the ways a player can matter, never a rank cut: the top of First
   * Seed's board, every member of a tier that could break at a position we can
   * still start, everyone named in a joint-availability comparison, the leaders
   * on the completed-roster simulation, and anyone whose source data conflicts.
   * A player outside all of those is genuinely not a candidate for THIS pick,
   * and he still appears on the deep board.
   */
  const richIds = new Set<string>();
  const openPositionsForBoard = new Set(
    brief.ourTeam.needs
      .filter((need) => need.openStartingSlots > 0 || need.depthNeed !== 'none')
      .map((need) => need.position),
  );

  const teamsBefore = new Map(
    brief.room.teamsBeforeOurNextPick.map((team) => [team.rosterId, team]),
  );
  const kickersMatter = brief.constraints.kickersAndDefensesAllowed;

  /*
   * Which opponents need naming player by player.
   *
   * The ones who pick before our next turn, because they are the reason a
   * candidate might not reach us - and the ones with a live need at a position
   * whose tier is about to break, because they are who breaks it. Everyone else
   * gets counts, holes, needs and a build label, which is what a distant team's
   * seven player names amount to anyway.
   */
  const atRiskPositions = new Set(
    brief.room.tierCliffs.filter((cliff) => cliff.atRisk).map((cliff) => cliff.position),
  );
  const teamsThatMatter = new Set<number>(
    brief.room.teamsBeforeOurNextPick
      .map((team) => team.rosterId)
      .filter((rosterId): rosterId is number => rosterId !== null),
  );
  for (const team of brief.opponents) {
    const pressesATier = team.needs.some(
      (need) =>
        atRiskPositions.has(need.position) &&
        ['critical', 'high'].includes(need.depthNeed),
    );
    if (pressesATier) teamsThatMatter.add(team.rosterId);
  }

  if (opts.compact) {
    const byFirstSeed = [...candidates].sort(
      (a, b) => (a.firstSeed.rank ?? Infinity) - (b.firstSeed.rank ?? Infinity),
    );
    for (const candidate of byFirstSeed.slice(0, RICH_TOP_BOARD)) richIds.add(candidate.playerId);

    const bySimulation = [...candidates].sort(
      (a, b) => (b.juancho.planValue ?? -Infinity) - (a.juancho.planValue ?? -Infinity),
    );
    for (const candidate of bySimulation.slice(0, RICH_SIMULATION_LEADERS)) {
      richIds.add(candidate.playerId);
    }

    for (const tier of brief.jointAvailability?.scenarios.tiers ?? []) {
      // Bounded: a tier is normally two to twenty deep, but a flat projection
      // curve can put a whole position in one, and an unbounded tier would
      // quietly defeat the compaction it is meant to inform.
      for (const member of tier.members.slice(0, RICH_PER_TIER)) richIds.add(member.playerId);
    }
    for (const pair of brief.jointAvailability?.pairs ?? []) {
      richIds.add(pair.a.playerId);
      richIds.add(pair.b.playerId);
    }
    for (const entry of brief.jointAvailability?.scenarios.fallbacks ?? []) {
      richIds.add(entry.playerId);
    }
    for (const entry of brief.jointAvailability?.scenarios.likelyBestAvailable ?? []) {
      richIds.add(entry.playerId);
    }
    for (const candidate of candidates) {
      if (candidate.dataWarning) richIds.add(candidate.playerId);
      // The best few at every position we could still start, so a real need is
      // never represented only by a thin row.
      if (openPositionsForBoard.has(candidate.position)) {
        const atPosition = candidates
          .filter((entry) => entry.position === candidate.position)
          .sort((a, b) => (a.firstSeed.rank ?? Infinity) - (b.firstSeed.rank ?? Infinity))
          .slice(0, RICH_PER_OPEN_POSITION);
        for (const entry of atPosition) richIds.add(entry.playerId);
      }
    }
  }

  return {
    contextVersion: PROMPT_CONTEXT_VERSION,

    pick: {
      overall: brief.draft.currentOverallPick,
      round: brief.draft.currentRound,
      ourSlot: brief.draft.ourDraftSlot,
      onTheClock: brief.draft.isOurSelection,
      nextOurPick: brief.draft.nextOurPick,
      picksUntilOurNextTurn: brief.draft.picksUntilOurNextSelection,
      selectionsWeStillOwn: brief.draft.ourRemainingSelections,
    },

    league: {
      teams: brief.league.teams,
      rounds: brief.league.rounds,
      scoring: brief.league.scoringProfile,
      qbFormat: brief.league.qbFormat,
      starters: describeSlots(brief),
      bench: brief.league.benchSlots,
      type: brief.league.leagueType,
    },

    us: describeOurTeam(brief.ourTeam, opts, kickersMatter),
    opponents: brief.opponents.map((team) =>
      describeTeam(team, opts, kickersMatter, opts.compact && !teamsThatMatter.has(team.rosterId)),
    ),

    upcoming: {
      order: brief.room.teamsBeforeOurNextPick
        .flatMap((team) =>
          team.selections.map((pick) => [pick, team.rosterId] as [number, number | null]),
        )
        .sort((a, b) => a[0] - b[0]),
      needs: Object.fromEntries(
        [...teamsBefore.values()].map((team) => [
          String(team.rosterId),
          describeNeeds(team.needs, kickersMatter),
        ]),
      ),
    },

    room: {
      totalDrafted: brief.room.totalDrafted,
      tendency: brief.room.tendency,
      positionShare: brief.room.positionShare,
      runs: brief.room.positionalRuns
        .filter((run) => run.isRun)
        .map(
          (run) =>
            `${run.position}: ${run.recentCount} of the last ${run.windowSize} picks, ${run.intensity}x normal`,
        ),
      recentPositionCounts: brief.room.recentPositionCounts,
      recent: recentTable(brief, opts.recentPicks),
      tierCliffs: tierCliffTable(brief),
    },

    board: boardTable(candidates, opts.blind, bestFinalRosterValue, richIds),
    ...(opts.compact
      ? { deepBoard: deepBoardTable(candidates, richIds, bestFinalRosterValue) }
      : {}),
    jointAvailability: jointTables(brief),
    dataWarnings: candidates
      .filter((candidate) => candidate.dataWarning !== null)
      .map((candidate) => ({
        playerId: candidate.playerId,
        name: candidate.name,
        position: candidate.position,
        code: candidate.dataWarning!.code,
        detail: candidate.dataWarning!.detail,
      })),

    ...(opts.blind
      ? {
          simulation: {
            bestFinalRosterValue: bestFinalRosterValue,
            firstSeedBestAvailable: firstSeedBest,
          },
        }
      : {
          juancho: {
            recommended: recommended
              ? {
                  playerId: recommended.playerId,
                  name: recommended.name,
                  position: recommended.position,
                  action: recommended.action,
                }
              : null,
            firstSeedBestAvailable: firstSeedBest,
            recommendedPlanValue: recommendedPlan,
            top: deterministicTable(brief, opts.deterministicDepth),
          },
        }),

    rules: {
      selectionsRemaining: brief.constraints.rosterSpotsRemaining,
      kickersAndDefensesAllowed: brief.constraints.kickersAndDefensesAllowed,
      blocked: brief.constraints.blockedPositions.map(
        (entry) => `${entry.position}: ${entry.reason}`,
      ),
      usableCapacity: brief.constraints.usableCapacity as Record<string, number>,
      mustFillBeforeDraftEnds:
        brief.constraints.mustFillBeforeDraftEnds
          .map((entry) => `${entry.position}x${entry.count}`)
          .join(' ') || 'none',
      mustReturn: [
        'A player id from the board table, exactly as written.',
        'Never a player already on any roster above - they are all taken.',
        'Never a position listed under blocked.',
        'Never more bodies at a position than usableCapacity allows.',
      ],
    },

    strategyContext: brief.strategyContext,
    playerNews: brief.playerNews,

    // Bookkeeping about what was left out is worth 269 tokens in the long form
    // and nothing to the decision; compact mode states it in one line.
    omitted: opts.compact
      ? [
          ...(opts.blind
            ? ['A deterministic ranking of these candidates is not included in this context.']
            : []),
          'Detail is spent where the decision needs it: distant opponents are summarised, ' +
            'and players outside the immediate decision appear on deepBoard at lower detail.',
        ]
      : [
      ...(opts.blind
        ? [
            'A deterministic ranking of these candidates is not included in this context.',
          ]
        : []),
      'Board fingerprint and brief version: our own request bookkeeping.',
      'Sleeper ids: the player id identifies him for both of us.',
      'Why each candidate is in the pool: audit metadata with no bearing on the pick.',
      "First Seed's upstream expert rank: provenance behind fsRank, not a separate signal.",
      ...(opts.blind
        ? []
        : [
            "Juancho's 0-100 score: strictly less informative than jRec, dPlan and dDec together.",
          ]),
      'Absolute plan and decision values per candidate: carried once as recommendedPlanValue, then as deltas.',
      'Weighted intervening demand: the team count it is derived from is in the survival columns.',
      'The list of drafted players: every one of them appears on exactly one roster above.',
      'Opponent starting lineups and benches: their holes and needs carry the same information.',
      'Opponent pick lists: the same players, already in their roster line with rounds.',
    ],
  };
}

/* ------------------------------------------------------------------- tables */

function boardTable(
  candidates: BriefCandidate[],
  blind: boolean,
  bestFinalRosterValue: number | null,
  /** When non-empty, only these players get the full metric set. */
  richIds: Set<string> = new Set(),
): CompactTable {
  const rows = richIds.size === 0
    ? candidates
    : candidates.filter((candidate) => richIds.has(candidate.playerId));
  /*
   * Blind mode drops three columns and re-bases a fourth.
   *
   * `jRec` and `act` are the verdict itself. `dDec` is the penalty-adjusted
   * ordering that produces it - the engine's judgement rather than its
   * simulation. And `dPlan` is measured FROM the recommended pick, so the row
   * reading zero is the recommendation: Sonnet spotted exactly that and wrote
   * "dPlan=0 (the baseline)" as a reason to follow it. Re-based to the best
   * final roster any candidate reaches, the same number becomes a simulation
   * result that names nobody's preference.
   */
  const columns = blind
    ? [
        'id', 'name', 'pos', 'tm', 'fsRank', 'fsGap', 'fsVal', 'fsMine', 'proj',
        'tier', 'left', 'surv', 'conf', 'projRank', 'posRank',
        'simGap', 'gain', 'age', 'note', 'warn',
      ]
    : [
        'id', 'name', 'pos', 'tm', 'fsRank', 'fsGap', 'fsVal', 'fsMine', 'proj',
        'tier', 'left', 'surv', 'conf', 'jRank', 'posRank', 'jRec', 'act',
        'dPlan', 'dDec', 'gain', 'age', 'note', 'warn',
      ];

  if (blind) {
    return {
      columns,
      legend: Object.fromEntries(columns.map((column) => [column, BOARD_LEGEND[column]])),
      rows: rows.map((candidate) => [
        candidate.playerId,
        candidate.name,
        candidate.position,
        candidate.team,
        candidate.firstSeed.rank,
        candidate.firstSeed.rankGapFromBestAvailable,
        candidate.firstSeed.valueDelta,
        candidate.firstSeed.landmineScore,
        candidate.juancho.projectedPoints,
        candidate.juancho.tier,
        candidate.juancho.playersRemainingInTier,
        candidate.survival.probability,
        candidate.survival.confidence === 'high' ? null : candidate.survival.confidence,
        candidate.juancho.boardRank,
        candidate.juancho.positionalRank,
        candidate.juancho.planValue === null || bestFinalRosterValue === null
          ? null
          : Math.round((candidate.juancho.planValue - bestFinalRosterValue) * 10) / 10,
        candidate.juancho.immediateRosterGain,
        candidate.age,
        candidate.status && candidate.status !== 'Active' ? candidate.status : null,
        candidate.dataWarning ? candidate.dataWarning.code : null,
      ]),
    };
  }

  return {
    columns,
    legend: Object.fromEntries(columns.map((column) => [column, BOARD_LEGEND[column]])),
    rows: rows.map((candidate) => [
      candidate.playerId,
      candidate.name,
      candidate.position,
      candidate.team,
      candidate.firstSeed.rank,
      candidate.firstSeed.rankGapFromBestAvailable,
      candidate.firstSeed.valueDelta,
      candidate.firstSeed.landmineScore,
      candidate.juancho.projectedPoints,
      candidate.juancho.tier,
      candidate.juancho.playersRemainingInTier,
      candidate.survival.probability,
      // Confidence is only worth a column when it is not the usual case.
      candidate.survival.confidence === 'high' ? null : candidate.survival.confidence,
      candidate.juancho.boardRank,
      candidate.juancho.positionalRank,
      candidate.juancho.recommendationRank,
      candidate.juancho.action,
      candidate.juancho.planValueVsRecommended,
      candidate.juancho.decisionValueVsRecommended,
      candidate.juancho.immediateRosterGain,
      candidate.age,
      candidate.status && candidate.status !== 'Active' ? candidate.status : null,
      candidate.dataWarning ? candidate.dataWarning.code : null,
    ]),
  };
}

/**
 * Everyone the rich board left out, in six columns instead of twenty.
 *
 * Not a truncation - every remaining available player is here. The point is
 * that a correct recommendation can never disappear because it fell outside a
 * top-N, while a player nobody would take does not cost twenty metrics.
 */
function deepBoardTable(
  candidates: BriefCandidate[],
  richIds: Set<string>,
  bestFinalRosterValue: number | null,
): CompactTable {
  const columns = ['id', 'name', 'pos', 'fsRank', 'proj', 'surv'];
  return {
    columns,
    legend: {
      id: 'player id - return this exact string to select him',
      name: 'player name',
      pos: 'position',
      fsRank: "First Seed's rank, or blank if they do not rank him",
      proj: 'projected points in this league scoring',
      surv: '% chance he is still available at our next selection',
      _note:
        'the rest of the available pool, at lower detail. Ask for nothing here ' +
        'lightly: if one of these is genuinely the right pick, say so - but the ' +
        'players a decision usually turns on are on the main board.',
    },
    rows: candidates
      .filter((candidate) => !richIds.has(candidate.playerId))
      .map((candidate) => [
        candidate.playerId,
        candidate.name,
        candidate.position,
        candidate.firstSeed.rank,
        candidate.juancho.projectedPoints,
        candidate.survival.probability,
      ]),
  };
}

function recentTable(brief: DraftBrief, limit: number): CompactTable {
  const columns = ['pick', 'team', 'name', 'pos', 'fsRank', 'fsGap'];
  return {
    columns,
    legend: {
      pick: 'overall pick number',
      team: 'roster id that made it',
      name: 'player taken',
      pos: 'position',
      fsRank: "First Seed's rank for him",
      fsGap: 'that rank minus the pick number; positive means they reached',
    },
    rows: brief.room.recentPicks
      .slice(-Math.max(0, limit))
      .map((pick) => [
        pick.overallPick,
        pick.rosterId,
        pick.name,
        pick.position,
        pick.firstSeedRank,
        pick.firstSeedRankGap,
      ]),
  };
}

function tierCliffTable(brief: DraftBrief): CompactTable {
  const columns = ['pos', 'tier', 'left', 'gapAfter', 'best', 'atRisk'];
  return {
    columns,
    legend: {
      pos: 'position',
      tier: 'best tier still available there',
      left: 'players remaining in it',
      gapAfter: 'projected points between this tier and the next',
      best: 'best player remaining in it',
      atRisk: 'true when no more remain than there are teams ahead of us needing the position',
    },
    rows: brief.room.tierCliffs.map((cliff) => [
      cliff.position,
      cliff.tier,
      cliff.playersRemainingInTier,
      cliff.gapAfterTier,
      cliff.bestRemaining?.name ?? null,
      cliff.atRisk ? 1 : 0,
    ]),
  };
}

function deterministicTable(brief: DraftBrief, depth: number): CompactTable {
  const columns = ['rank', 'id', 'name', 'pos', 'plan', 'dDec'];
  return {
    columns,
    legend: {
      rank: "position in Juancho's ranking",
      id: 'player id',
      name: 'player name',
      pos: 'position',
      plan: 'expected value of our final roster from this pick',
      dDec: 'penalty-adjusted gap to the top pick',
      /*
       * Said explicitly because the table contradicts itself otherwise. The
       * order is not dDec: after ranking, the engine re-sorts its leaders by a
       * take-now-versus-wait comparison and demotes anyone beaten on BOTH First
       * Seed's board and its own simulation. Both can lift a candidate above
       * one with a better dDec, and a model shown that without explanation will
       * stop trusting the whole table.
       */
      _order:
        'rank is not sorted by dDec: the leaders are re-ordered by whether taking ' +
        'a player now beats waiting for him, and anyone beaten on both First Seed ' +
        "rank and final-roster value is demoted below those who are not",
    },
    rows: brief.deterministic.top
      .slice(0, Math.max(0, depth))
      .map((entry) => [
        entry.rank,
        entry.playerId,
        entry.name,
        entry.position,
        entry.planValue,
        entry.decisionValueDelta,
      ]),
  };
}

/* ------------------------------------------------------ joint availability */

/**
 * The joint figures, as four small tables.
 *
 * Kept to the comparisons a decision turns on rather than a matrix over the
 * board: ten to fifteen rows against twenty thousand, and the rows are the ones
 * the pick is actually being decided between.
 */
function jointTables(brief: DraftBrief): StrategistPromptContext['jointAvailability'] {
  const joint = brief.jointAvailability;
  if (!joint) return null;

  const pairColumns = ['a', 'b', 'aSurv', 'bSurv', 'both', 'either', 'neither', 'bIfAGone', 'why'];
  const tierColumns = ['pos', 'tier', 'members', 'eitherRemains', 'allRemain', 'expected'];
  const boardColumns = ['name', 'pos', 'chanceBestAvailable'];
  const fallbackColumns = ['pos', 'name', 'survives', 'chanceBestAtPos'];

  return {
    runs: joint.scenarios.runs,
    interveningSelections: joint.scenarios.interveningSelections,
    pairs: {
      columns: pairColumns,
      legend: {
        a: 'first player',
        b: 'second player',
        aSurv: '% of runs A was still available at our next selection',
        bSurv: '% of runs B was still available',
        both: '% of runs BOTH were still available - not aSurv x bSurv, counted',
        either: '% of runs at least one was still available',
        neither: '% of runs both were gone',
        bIfAGone: '% of the runs where A was taken in which B still survived',
        why: 'why this comparison is here',
      },
      rows: joint.pairs.map((pair) => [
        `${pair.a.name} (${pair.a.position})`,
        `${pair.b.name} (${pair.b.position})`,
        pair.aSurvives,
        pair.bSurvives,
        pair.bothSurvive,
        pair.atLeastOneSurvives,
        pair.neitherSurvives,
        pair.bSurvivesGivenAGone,
        pair.reason,
      ]),
    },
    tiers: {
      columns: tierColumns,
      legend: {
        pos: 'position',
        tier: 'the best tier still available there',
        members: 'who is in it, with each one\'s own survival %',
        eitherRemains: '% of runs at least one member was still available',
        allRemain: '% of runs every member was still available',
        expected: 'average number of members still available',
      },
      rows: joint.scenarios.tiers.map((tier) => [
        tier.position,
        tier.tier,
        tier.members.map((member) => `${member.name} ${member.survives}%`).join(', '),
        tier.atLeastOneRemains,
        tier.allRemain,
        tier.expectedSurvivors,
      ]),
    },
    nextPickBoard: {
      columns: boardColumns,
      legend: {
        name: 'player',
        pos: 'position',
        chanceBestAvailable:
          '% of runs he was the best-ranked player left when our turn came',
      },
      rows: joint.scenarios.likelyBestAvailable.map((entry) => [
        entry.name,
        entry.position,
        entry.frequency,
      ]),
    },
    fallbacks: {
      columns: fallbackColumns,
      legend: {
        pos: 'a position we can still start somebody at',
        name: 'the best player there who is NOT the deterministic pick',
        survives: '% of runs he was still available at our next selection',
        chanceBestAtPos: '% of runs he was the best of his position still left',
      },
      rows: joint.scenarios.fallbacks.map((fallback) => [
        fallback.position,
        fallback.name,
        fallback.survives,
        fallback.isBestOfPositionAtNextPick,
      ]),
    },
  };
}

/* -------------------------------------------------------------------- teams */

function describeTeam(
  team: BriefTeam,
  opts: PromptContextOptions,
  includeKickers: boolean,
  summariseOnly = false,
): CompactTeam {
  return {
    id: team.rosterId,
    slot: team.draftSlot,
    name: team.teamName,
    // A distant team's roster is only ever read as "what do they still need",
    // which the counts, holes and needs below already say.
    roster: summariseOnly
      ? ''
      : team.players
          .map((player) => `${player.round ?? '-'}.${player.position} ${player.name}`)
          .join(', '),
    counts: describeCounts(team),
    holes: team.lineupHoles.flatMap((hole) => Array(hole.count).fill(hole.slot)).join(' ') || 'none',
    needs: describeNeeds(team.needs, includeKickers),
    build: team.build,
    reachesAt: team.tendency.reachedEarlyAt.length ? team.tendency.reachedEarlyAt.join(',') : null,
    recent: team.picks
      .slice(-Math.max(0, summariseOnly ? 2 : opts.opponentRecentPicks))
      .map((pick) => pick.position)
      .join(','),
    nextPick: team.nextSelectionOverall,
  };
}

function describeOurTeam(
  team: BriefTeam,
  opts: PromptContextOptions,
  includeKickers: boolean,
): OurTeamContext {
  return {
    ...describeTeam(team, opts, includeKickers),
    lineup: team.startingLineup
      .map((slot) => `${slot.slot}=${slot.filledBy ? slot.filledBy.name : 'EMPTY'}`)
      .join(', '),
    bench: team.bench.map((player) => `${player.position} ${player.name}`).join(', ') || 'empty',
    positions: team.needs
      .filter((need) => includeKickers || (need.position !== 'K' && need.position !== 'DEF'))
      .filter((need) => need.drafted > 0 || need.startersRequired > 0)
      .map((need) => ({
        position: need.position,
        drafted: need.drafted,
        starters: `${need.startersFilled}/${need.startersRequired}`,
        open: need.openStartingSlots,
        need: need.depthNeed,
        saturation: need.saturation,
        quality: need.starterQuality,
      })),
  };
}

function describeCounts(team: BriefTeam): string {
  return (
    Object.entries(team.positionCounts)
      .filter(([, count]) => (count ?? 0) > 0)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([position, count]) => `${position}${count}`)
      .join(' ') || 'empty'
  );
}

/**
 * Only positions with a real need. A satisfied position is not worth a word.
 *
 * Kickers and defenses are excluded until they can actually be selected. Every
 * team in the league needs one from the first round, so listing them says
 * nothing about anybody while costing a line on all ten rosters - and they are
 * still visible in `holes` and in `rules.mustFillBeforeDraftEnds`.
 */
function describeNeeds(needs: BriefPositionNeed[], includeKickers: boolean): string {
  return (
    needs
      .filter((need) => includeKickers || (need.position !== 'K' && need.position !== 'DEF'))
      .filter((need) => ['critical', 'high', 'medium'].includes(need.depthNeed))
      .map((need) => `${need.position}:${need.depthNeed}`)
      .join(' ') || 'none'
  );
}

function describeSlots(brief: DraftBrief): string {
  const slots = brief.league.slots;
  return (
    (Object.keys(slots) as (keyof typeof slots)[])
      .filter((slot) => slots[slot] > 0)
      .map((slot) => (slots[slot] > 1 ? `${slots[slot]}x${slot}` : slot))
      .join(' ') || 'none'
  );
}

/**
 * Trims the board while keeping what the decision turns on.
 *
 * Everyone Juancho reported in `juancho.top` survives any cap - a strategist
 * that cannot see the deterministic pick and the alternatives behind it cannot
 * meaningfully agree or disagree with it. Protecting the whole shortlist
 * instead would defeat the cap entirely, since the engine plans forty-odd
 * candidates. Everything else is kept in First Seed rank order.
 */
function keepBest(
  candidates: BriefCandidate[],
  limit: number,
  protectedIds: Set<string>,
): BriefCandidate[] {
  if (candidates.length <= limit) return candidates;
  const kept = new Map<string, BriefCandidate>();
  for (const candidate of candidates) {
    if (protectedIds.has(candidate.playerId)) kept.set(candidate.playerId, candidate);
  }
  for (const candidate of candidates) {
    if (kept.size >= limit) break;
    kept.set(candidate.playerId, candidate);
  }
  return candidates.filter((candidate) => kept.has(candidate.playerId));
}
