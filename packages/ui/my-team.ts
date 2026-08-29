/**
 * Our own roster, as the left rail shows it.
 *
 * Deliberately independent of the recommendation engine. The rail has to be
 * right before projections have loaded, after the draft has finished, and in a
 * mock where Sleeper reports no roster id on any pick - none of which are
 * states in which `generateDraftRecommendations` returns anything. So this
 * reads the same primitives the engine reads and uses the engine's own lineup
 * solver, rather than a second idea of what a starting lineup is.
 *
 * `solveBestLineup` orders by projection, so an unprojected roster still fills
 * its slots correctly by position; the points beside each name are simply
 * absent. That is the intended degradation: a drafter needs to see that his
 * TE slot is empty long before he needs to see what the TE is worth.
 */
import type { RosterConfiguration } from '../engine/context/types';
import {
  lineupSlotsFor,
  solveBestLineup,
  type LineupSlots,
  type LineupPlayer,
} from '../engine/draft/lineup';
import { resolvePickRosterId, type SlotToRosterId } from '../engine/draft/pick-ownership';
import type { CanonicalPlayer, CanonicalPlayerMap, Position } from '../players/types';
import type { SleeperDraftPick, SleeperRoster } from '../sleeper/types';

export interface RosterEntry {
  playerId: string;
  sleeperId: string | null;
  name: string;
  position: Position;
  team: string | null;
  /** League-scored projection, or null when nothing projects him. */
  projectedPoints: number | null;
  /** The selection that acquired him. Null for a pre-draft keeper. */
  overallPick: number | null;
  round: number | null;
}

export interface LineupSlotView {
  /** `QB`, `RB`, `FLEX`, `SUPER_FLEX`, … - one entry per individual slot. */
  slot: keyof LineupSlots;
  /** 1-based within slots of the same kind, so two RB rows read RB1 / RB2. */
  index: number;
  player: RosterEntry | null;
}

export interface PositionNeedView {
  position: Position;
  filled: number;
  required: number;
  /** How many starting slots at this position are still empty. */
  open: number;
}

export interface MyTeamModel {
  rosterId: number | null;
  slots: LineupSlots;
  starters: LineupSlotView[];
  bench: RosterEntry[];
  /** Bench spots the roster has room for but has not used. */
  emptyBenchSlots: number;
  needs: PositionNeedView[];
  /**
   * Positions with an empty starting slot, each listed once with a count.
   *
   * Counted rather than repeated: "RB · RB · WR · WR" is the same information
   * as "2 RB · 2 WR" and takes twice the width to say it.
   */
  openStartingPositions: { position: Position; count: number }[];
  totalDrafted: number;
  /** Projected points of the starting lineup, null when nothing is projected. */
  startingPoints: number | null;
}

const STARTER_ORDER: (keyof LineupSlots)[] = [
  'QB',
  'RB',
  'WR',
  'TE',
  'FLEX',
  'SUPER_FLEX',
  'K',
  'DEF',
];

/** The positions a rail lists needs for. K and DEF are added only when started. */
const NEED_ORDER: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

export function deriveMyTeam({
  rosterId,
  picks,
  rosters,
  players,
  projections,
  roster,
  benchSlots,
  slotToRosterId,
}: {
  rosterId: number | null;
  picks: SleeperDraftPick[];
  rosters: SleeperRoster[];
  players: CanonicalPlayerMap;
  /** Player id to league-scored points. Empty before projections load. */
  projections: Map<string, number>;
  roster: RosterConfiguration;
  benchSlots: number;
  slotToRosterId: SlotToRosterId;
}): MyTeamModel {
  const slots = lineupSlotsFor(roster);
  const owned = collectOwned({ rosterId, picks, rosters, players, projections, slotToRosterId });

  const lineupInput: LineupPlayer[] = owned.map((entry) => ({
    playerId: entry.playerId,
    position: entry.position,
    projection: entry.projectedPoints ?? 0,
  }));
  const solved = solveBestLineup(lineupInput, slots);
  const byId = new Map(owned.map((entry) => [entry.playerId, entry]));

  const starters = layOutSlots(slots, solved.assignments, byId);
  const startingIds = new Set(solved.starters.map((player) => player.playerId));
  const bench = owned
    .filter((entry) => !startingIds.has(entry.playerId))
    .sort((a, b) => (b.projectedPoints ?? 0) - (a.projectedPoints ?? 0));

  const anyProjected = owned.some((entry) => entry.projectedPoints !== null);

  return {
    rosterId,
    slots,
    starters,
    bench,
    emptyBenchSlots: Math.max(0, benchSlots - bench.length),
    needs: describeNeeds(slots, owned),
    openStartingPositions: countOpenSlots(starters),
    totalDrafted: owned.length,
    startingPoints: anyProjected ? solved.total : null,
  };
}

function collectOwned({
  rosterId,
  picks,
  rosters,
  players,
  projections,
  slotToRosterId,
}: {
  rosterId: number | null;
  picks: SleeperDraftPick[];
  rosters: SleeperRoster[];
  players: CanonicalPlayerMap;
  projections: Map<string, number>;
  slotToRosterId: SlotToRosterId;
}): RosterEntry[] {
  if (rosterId === null) return [];

  const entries: RosterEntry[] = [];
  const seen = new Set<string>();

  const push = (player: CanonicalPlayer, pick: SleeperDraftPick | null) => {
    if (seen.has(player.id)) return;
    seen.add(player.id);
    entries.push({
      playerId: player.id,
      sleeperId: player.externalIds.sleeper ?? null,
      name: player.name,
      position: player.position,
      team: player.team ?? null,
      projectedPoints: projections.get(player.id) ?? null,
      overallPick: pick?.pick_no ?? null,
      round: pick?.round ?? null,
    });
  };

  for (const pick of picks) {
    if (resolvePickRosterId(pick, slotToRosterId) !== rosterId) continue;
    const player = players.bySleeperId.get(pick.player_id);
    if (player) push(player, pick);
  }
  // Keepers and anyone already on the roster before the draft opened.
  const stored = rosters.find((candidate) => candidate.roster_id === rosterId);
  for (const sleeperId of stored?.players ?? []) {
    const player = players.bySleeperId.get(sleeperId);
    if (player) push(player, null);
  }

  return entries.sort((a, b) => (a.overallPick ?? 0) - (b.overallPick ?? 0));
}

/**
 * One row per individual starting slot, filled or empty.
 *
 * The empty rows are the point of the rail: a drafter learns more from seeing
 * an unfilled TE line than from reading that he has drafted six players.
 */
function layOutSlots(
  slots: LineupSlots,
  assignments: { slot: keyof LineupSlots; player: LineupPlayer }[],
  byId: Map<string, RosterEntry>,
): LineupSlotView[] {
  const queued = new Map<keyof LineupSlots, RosterEntry[]>();
  for (const assignment of assignments) {
    const entry = byId.get(assignment.player.playerId);
    if (!entry) continue;
    const list = queued.get(assignment.slot) ?? [];
    list.push(entry);
    queued.set(assignment.slot, list);
  }

  const views: LineupSlotView[] = [];
  for (const slot of STARTER_ORDER) {
    const count = slots[slot];
    const filled = queued.get(slot) ?? [];
    for (let index = 0; index < count; index += 1) {
      views.push({ slot, index: index + 1, player: filled[index] ?? null });
    }
  }
  return views;
}

function countOpenSlots(starters: LineupSlotView[]): { position: Position; count: number }[] {
  const counts = new Map<Position, number>();
  for (const view of starters) {
    // FLEX and SUPER_FLEX are not positions, so they cannot be "still to fill
    // at a position" - the roster needs a body, not a particular one.
    if (view.player !== null || view.slot === 'FLEX' || view.slot === 'SUPER_FLEX') continue;
    const position = view.slot as Position;
    counts.set(position, (counts.get(position) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([position, count]) => ({ position, count }))
    .sort((a, b) => b.count - a.count);
}

function describeNeeds(slots: LineupSlots, owned: RosterEntry[]): PositionNeedView[] {
  const counts = new Map<Position, number>();
  for (const entry of owned) {
    counts.set(entry.position, (counts.get(entry.position) ?? 0) + 1);
  }

  const needs: PositionNeedView[] = [];
  for (const position of NEED_ORDER) {
    const required = requiredAt(position, slots);
    // A position nobody starts in this league is not a need, and listing it as
    // `0/0` is noise on a rail that has to be readable at a glance.
    if (required === 0 && (counts.get(position) ?? 0) === 0) continue;
    const filled = counts.get(position) ?? 0;
    needs.push({
      position,
      filled,
      required,
      open: Math.max(0, required - filled),
    });
  }
  return needs;
}

/** Dedicated slots only - flex is shared, so charging it to one position lies. */
function requiredAt(position: Position, slots: LineupSlots): number {
  switch (position) {
    case 'QB':
      return slots.QB;
    case 'RB':
      return slots.RB;
    case 'WR':
      return slots.WR;
    case 'TE':
      return slots.TE;
    case 'K':
      return slots.K;
    case 'DEF':
      return slots.DEF;
    default:
      return 0;
  }
}
