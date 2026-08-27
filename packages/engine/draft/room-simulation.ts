/**
 * What the room will actually do before our next turn.
 *
 * The old estimate asked, separately for each player, "how likely is he to be
 * gone by our next selection?" and answered with a normal curve around his
 * market rank multiplied by a generic demand factor. Every answer was computed
 * in isolation, which meant nothing tied them together - and the calibration
 * study showed exactly what that produces: at pick 21, with eighteen selections
 * to come, the model expected sixty-two of the eighty-four players it was
 * describing to be gone. Only eighteen players can leave in eighteen picks. It
 * was not mildly pessimistic; it was describing a draft that cannot happen.
 *
 * The fix is not a calibration curve on top of a broken model. It is to model
 * the thing that actually determines availability: the selections themselves.
 * Exactly one player leaves per pick because exactly one player is chosen per
 * pick, so the constraint holds by construction rather than by correction.
 *
 * Each simulated selection asks who is on the clock, what THEIR roster looks
 * like after every prior simulated pick, and what they therefore want - so a
 * team that takes a quarterback at pick 70 no longer wants one at 71, and a run
 * on tight ends emerges from teams needing tight ends rather than from a hazard
 * rate applied to everybody at once.
 */
import type { Position } from '../../players/types';
import { startingFootprint } from './roster-state';
import type { LineupSlots } from './lineup';

/** How many futures to play out. */
export const DEFAULT_SIMULATION_RUNS = 300;

/**
 * How far past the best available player a team realistically reaches.
 *
 * A softmax over board rank with this scale is equivalent to each team
 * perceiving value as "rank plus noise" and taking the best it sees, which is
 * what a draft room actually looks like: mostly near the top of the board, but
 * not identically so, and occasionally a genuine reach.
 *
 * Eight ranks is roughly two-thirds of a round in a ten-to-twelve team league.
 * Chosen from how drafts behave, deliberately NOT fitted to the saved mocks -
 * a parameter tuned on three boards would predict those three boards and
 * nothing else.
 */
export const RANK_SCALE = 8;

/**
 * The same scale, for a draft with no published board to reach from.
 *
 * Without a First Seed ranking, `consensusRank` falls back to our own
 * projection order - which in a one-quarterback league puts quarterbacks on
 * top, and says almost nothing about when the ROOM will take anybody. The old
 * model expressed that doubt by pulling its answer toward even odds afterwards.
 * That is the wrong place for it: shrinking outputs breaks the one property
 * this model exists to guarantee, since the removals no longer sum to the
 * number of picks.
 *
 * So the doubt goes where it belongs - into the simulation. A wide scale makes
 * the room nearly indifferent across the players it is considering, which is an
 * honest description of not knowing what it will do, and still removes exactly
 * one player per selection.
 */
export const RANK_SCALE_WITHOUT_BOARD = 30;

/** How far down the board a team is modelled as even considering. */
export const CANDIDATE_DEPTH = 40;

/**
 * How much a team wants another body at a position, given what it holds.
 *
 * Deliberately modest. First Seed's board already knows WHEN positions come off
 * in this format - it is built for it - so the rank prior does most of the
 * work and these multipliers only express what the board cannot know: this
 * particular team's roster. Making them large would replace a good positional
 * prior with a crude need heuristic.
 */
const APPETITE = {
  /** A required starting slot they have not filled. */
  missingStarter: 2,
  /** Filled the dedicated slots, but the position can still claim a flex. */
  flexEligible: 1,
  /** Beyond the lineup, but useful cover for byes and injuries. */
  usefulDepth: 0.45,
  /** Past anything the lineup can use, at a position with real depth value. */
  surplus: 0.12,
  /** Past capacity at a single-slot position - a third QB in a 1QB league. */
  unusable: 0.02,
  /** Kickers and defenses before the closing rounds. Nobody does this. */
  tooEarlyForKicker: 0.01,
  /** A mandatory kicker or defense slot in the closing rounds. */
  mandatoryLateSlot: 2.5,
} as const;

/**
 * Where a needed kicker or defense sits on a board that does not rank them.
 *
 * First Seed publishes no kickers or defenses, so they have no rank to reach
 * from and the softmax would give them a weight of essentially zero forever -
 * yet rooms plainly do draft them, in the last two rounds, when the slot is
 * still empty. A team in that situation is not comparing its kicker to a
 * receiver on rank; it is filling a slot it must fill. Treating the best
 * available kicker as sitting just behind the best available player models
 * that, and only while the slot is open and the closing rounds have started.
 */
const LATE_SLOT_EFFECTIVE_GAP = 5;

export interface SimulationCandidate {
  playerId: string;
  position: Position;
  /** First Seed's rank, or our projection order where there is no board. */
  consensusRank: number;
}

/** One selection the room makes between now and our next turn. */
export interface SimulatedSelection {
  overallPick: number;
  /** Null when the seat cannot be resolved; modelled as an average team. */
  rosterId: number | null;
}

export interface RoomSimulationInput {
  /** The intervening selections, in draft order. */
  selections: SimulatedSelection[];
  available: SimulationCandidate[];
  /** What each roster already holds, before any simulated pick. */
  rosterCounts: Map<number, Partial<Record<Position, number>>>;
  slots: LineupSlots;
  teams: number;
  totalRounds: number;
  runs?: number;
  /** Defaults to `RANK_SCALE`; widen it when the board is not a real consensus. */
  rankScale?: number;
  /**
   * Seeded so the same board always produces the same probabilities.
   *
   * The regression corpus replays boards and compares them byte for byte, and
   * a live screen that reported a different number every poll would be
   * unusable. Randomness here is a modelling device, not a source of variety.
   */
  seed: number;
}

export interface RoomSimulationResult {
  runs: number;
  selectionsSimulated: number;
  /** 0-100 chance the player is still on the board at our next selection. */
  survival: Map<string, number>;
  /** The individual futures, kept so joint questions can be answered exactly. */
  outcomes: RoomOutcomes;
}

/**
 * What happened in each simulated future, rather than only the average of them.
 *
 * A marginal probability cannot answer "will at least ONE of these two tight
 * ends reach us?" - that depends on whether the same selections remove both,
 * and the events are strongly coupled: a room that takes Warren has one fewer
 * pick left to take Kraft. Multiplying marginals assumes independence and gets
 * it wrong in the direction that matters.
 *
 * The runs already contain the answer. Keeping which players survived in each
 * one turns any joint question into counting, with no modelling assumption
 * added on top.
 */
export interface RoomOutcomes {
  runs: number;
  /** Player id to a per-run flag: 1 if he was still there at our next pick. */
  survivalByRun: Map<string, Uint8Array>;
  /** The best-ranked survivor in each run, or null if the board emptied. */
  bestAvailableByRun: (string | null)[];
  /** The same, per position. */
  bestAvailableByPositionByRun: Map<Position, (string | null)[]>;
}

export interface SimulatedPick {
  overallPick: number;
  rosterId: number | null;
  playerId: string;
  position: Position;
}

/**
 * Plays the room forward many times and counts how often each player survives.
 *
 * One simulation, not one per player: the whole point is that the candidates
 * share a model of the same selections, so their survival probabilities are
 * consistent with each other and with the number of picks that exist.
 */
export function simulateRoom(input: RoomSimulationInput): RoomSimulationResult {
  const runs = Math.max(1, input.runs ?? DEFAULT_SIMULATION_RUNS);
  const survival = new Map<string, number>();

  // Nobody picks in between, so everybody is available. Exactly, not probably.
  if (input.selections.length === 0) {
    for (const candidate of input.available) survival.set(candidate.playerId, 100);
    const outcomes = emptyOutcomes(input.available, runs);
    const board = [...input.available].sort((a, b) => a.consensusRank - b.consensusRank);
    for (let run = 0; run < runs; run += 1) recordBestAvailable(outcomes, board, new Set(), run);
    return { runs, selectionsSimulated: 0, survival, outcomes };
  }

  const takenCount = new Map<string, number>();
  const random = mulberry32(input.seed);
  const outcomes = emptyOutcomes(input.available, runs);
  const board = [...input.available].sort((a, b) => a.consensusRank - b.consensusRank);

  for (let run = 0; run < runs; run += 1) {
    const taken = new Set<string>();
    for (const pick of simulateOnce(input, random)) {
      takenCount.set(pick.playerId, (takenCount.get(pick.playerId) ?? 0) + 1);
      taken.add(pick.playerId);
      outcomes.survivalByRun.get(pick.playerId)![run] = 0;
    }
    recordBestAvailable(outcomes, board, taken, run);
  }

  for (const candidate of input.available) {
    const taken = takenCount.get(candidate.playerId) ?? 0;
    survival.set(candidate.playerId, round1((1 - taken / runs) * 100));
  }

  return { runs, selectionsSimulated: input.selections.length, survival, outcomes };
}

function emptyOutcomes(available: SimulationCandidate[], runs: number): RoomOutcomes {
  const survivalByRun = new Map<string, Uint8Array>();
  for (const candidate of available) {
    // Everyone survives until a run says otherwise, which is the cheap
    // direction: a run removes at most one player per selection.
    survivalByRun.set(candidate.playerId, new Uint8Array(runs).fill(1));
  }
  const positions = new Set(available.map((candidate) => candidate.position));
  const bestAvailableByPositionByRun = new Map<Position, (string | null)[]>();
  for (const position of positions) {
    bestAvailableByPositionByRun.set(position, new Array(runs).fill(null));
  }
  return {
    runs,
    survivalByRun,
    bestAvailableByRun: new Array(runs).fill(null),
    bestAvailableByPositionByRun,
  };
}

/** One pass down the board per run, stopping once every position is answered. */
function recordBestAvailable(
  outcomes: RoomOutcomes,
  board: SimulationCandidate[],
  taken: Set<string>,
  run: number,
): void {
  const remaining = new Set(outcomes.bestAvailableByPositionByRun.keys());
  for (const candidate of board) {
    if (taken.has(candidate.playerId)) continue;
    if (outcomes.bestAvailableByRun[run] === null) {
      outcomes.bestAvailableByRun[run] = candidate.playerId;
    }
    if (remaining.has(candidate.position)) {
      outcomes.bestAvailableByPositionByRun.get(candidate.position)![run] = candidate.playerId;
      remaining.delete(candidate.position);
      if (remaining.size === 0) return;
    }
  }
}

/**
 * One future, played out selection by selection.
 *
 * Exported so the invariants can be checked directly rather than inferred from
 * aggregate probabilities: exactly one player leaves per pick, nobody leaves
 * twice, and a team's roster changes before it picks again.
 */
export function simulateOnce(
  input: RoomSimulationInput,
  random: () => number,
): SimulatedPick[] {
  const { available, selections, slots, rosterCounts } = input;

  // Board order is fixed for the whole run, so the scan below is a walk down a
  // pre-sorted list rather than a sort per selection.
  const board = [...available].sort((a, b) => a.consensusRank - b.consensusRank);
  const taken = new Set<string>();

  // A private copy, because these change as the simulated draft proceeds - that
  // is the entire point of simulating it sequentially.
  const counts = new Map<number, Map<Position, number>>();
  for (const [rosterId, positions] of rosterCounts) {
    counts.set(
      rosterId,
      new Map(Object.entries(positions).map(([position, count]) => [position as Position, count ?? 0])),
    );
  }

  const picks: SimulatedPick[] = [];

  for (const selection of selections) {
    const held = selection.rosterId === null ? null : counts.get(selection.rosterId) ?? new Map();

    const chosen = chooseOne({
      board,
      taken,
      held,
      slots,
      rankScale: input.rankScale ?? RANK_SCALE,
      /*
       * Worked out from the pick itself, not from the round we are in now: a
       * gap of eighteen selections crosses a round boundary, and whether
       * kickers are in play can genuinely change inside one simulated stretch.
       */
      kickersAllowed: kickersAllowedAt(selection.overallPick, input.teams, input.totalRounds),
      random,
    });
    if (!chosen) continue;

    taken.add(chosen.playerId);
    picks.push({
      overallPick: selection.overallPick,
      rosterId: selection.rosterId,
      playerId: chosen.playerId,
      position: chosen.position,
    });

    // The update that makes this sequential rather than parallel: the team that
    // just took a quarterback does not want one at its next selection.
    if (selection.rosterId !== null) {
      const roster = counts.get(selection.rosterId) ?? new Map<Position, number>();
      roster.set(chosen.position, (roster.get(chosen.position) ?? 0) + 1);
      counts.set(selection.rosterId, roster);
    }
  }

  return picks;
}

/**
 * One team's selection.
 *
 * Weight is the board prior times this team's appetite for the position. The
 * board prior is a softmax over how far past the best available player a
 * candidate sits, which is what "reaches sometimes, mostly does not" looks like
 * when written down.
 */
function chooseOne({
  board,
  taken,
  held,
  slots,
  rankScale,
  kickersAllowed,
  random,
}: {
  board: SimulationCandidate[];
  taken: Set<string>;
  held: Map<Position, number> | null;
  slots: LineupSlots;
  rankScale: number;
  kickersAllowed: boolean;
  random: () => number;
}): SimulationCandidate | null {
  const considered: SimulationCandidate[] = [];
  let bestRank = Number.POSITIVE_INFINITY;
  for (const candidate of board) {
    if (taken.has(candidate.playerId)) continue;
    if (considered.length === 0) bestRank = candidate.consensusRank;
    considered.push(candidate);
    if (considered.length >= CANDIDATE_DEPTH) break;
  }
  if (considered.length === 0) return null;

  const weights: number[] = [];
  let total = 0;
  for (const candidate of considered) {
    const appetite = appetiteFor(candidate.position, held, slots, kickersAllowed);
    const mandatoryLate =
      kickersAllowed &&
      (candidate.position === 'K' || candidate.position === 'DEF') &&
      appetite >= APPETITE.mandatoryLateSlot;
    const gap = mandatoryLate
      ? LATE_SLOT_EFFECTIVE_GAP
      : candidate.consensusRank - bestRank;
    const weight = Math.exp(-Math.max(0, gap) / rankScale) * appetite;
    weights.push(weight);
    total += weight;
  }

  // Degenerate only if every appetite is zero, which cannot happen: some
  // position is always at least surplus-worthy. Guarded anyway.
  if (total <= 0) return considered[0];

  let threshold = random() * total;
  for (let index = 0; index < considered.length; index += 1) {
    threshold -= weights[index];
    if (threshold <= 0) return considered[index];
  }
  return considered[considered.length - 1];
}

/**
 * How badly this team wants another body at this position.
 *
 * Reads off the same lineup model the rest of the engine uses, so "can this
 * position still reach a starting slot" means the same thing here as it does
 * when we evaluate our own roster.
 */
export function appetiteFor(
  position: Position,
  held: Map<Position, number> | null,
  slots: LineupSlots,
  kickersAllowed: boolean,
): number {
  // An unknown seat is modelled as an average team rather than as no team,
  // which would silently make everyone safer than they are.
  if (held === null) return APPETITE.flexEligible;

  const owned = held.get(position) ?? 0;
  const dedicated = dedicatedSlots(position, slots);

  if (position === 'K' || position === 'DEF') {
    if (!kickersAllowed) return APPETITE.tooEarlyForKicker;
    return owned < dedicated ? APPETITE.mandatoryLateSlot : APPETITE.unusable;
  }

  const footprint = startingFootprint(position, slots);
  const capacity = Math.ceil(footprint) + 1;

  if (owned < dedicated) return APPETITE.missingStarter;
  if (owned < footprint) return APPETITE.flexEligible;
  if (owned < capacity) return APPETITE.usefulDepth;
  // A position with a single lineup spot cannot use a third body at all; one
  // with real flex access still has some bench value.
  return footprint <= 1.5 ? APPETITE.unusable : APPETITE.surplus;
}

function dedicatedSlots(position: Position, slots: LineupSlots): number {
  if (position === 'QB') return slots.QB;
  if (position === 'RB') return slots.RB;
  if (position === 'WR') return slots.WR;
  if (position === 'TE') return slots.TE;
  if (position === 'K') return slots.K;
  if (position === 'DEF') return slots.DEF;
  return 0;
}

/** Kickers and defenses come off the board in the closing rounds, not before. */
export function kickersAllowedAt(
  overallPick: number,
  teams: number,
  totalRounds: number,
): boolean {
  const round = Math.ceil(overallPick / Math.max(1, teams));
  return round >= Math.max(1, totalRounds - 2);
}

/**
 * A small seeded generator, so the same board always yields the same numbers.
 *
 * `Math.random` would make the live screen report a different probability on
 * every poll and would break byte-for-byte corpus replays.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (value: number) => Math.round(value * 10) / 10;
