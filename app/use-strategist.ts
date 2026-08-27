'use client';

/**
 * The strategist, subscribed to from React.
 *
 * Deliberately thin. Everything worth testing - when to call, what counts as
 * stale, what to do with each kind of failure - lives in `LiveStrategist`,
 * which needs no browser and is covered by fakes. This only connects it to a
 * component's lifecycle.
 *
 * Note what it does NOT do: it never blocks a render and never sits between the
 * deterministic recommendation and the screen. The panel draws Juancho's answer
 * the moment the board changes, and this upgrades it later or not at all.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_CALL_POLICY,
  LiveStrategist,
  UsageLedger,
  type LiveStrategistState,
  type StrategistCallPolicy,
  type StrategistTransport,
} from '../packages/engine/strategist/live';
import type { DraftBrief } from '../packages/engine/strategist/types';
import { HttpStrategistTransport } from './strategist-transport';

export interface UseStrategistOptions {
  /** Swappable so tests and previews never touch the network. */
  transport?: StrategistTransport;
  policy?: Partial<StrategistCallPolicy>;
}

export function useStrategist(
  brief: DraftBrief | null,
  options: UseStrategistOptions = {},
): LiveStrategistState {
  const { transport, policy } = options;

  /*
   * One strategist for the life of the component. Rebuilding it on each render
   * would lose the record of which boards have already been asked about, and
   * every poll would become a paid call.
   */
  const live = useMemo(
    () =>
      new LiveStrategist(
        transport ?? new HttpStrategistTransport(),
        { ...DEFAULT_CALL_POLICY, ...policy },
        new UsageLedger(),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transport, policy?.analyzeWithin, policy?.enabled, policy?.refreshOnTheClock],
  );

  const [state, setState] = useState<LiveStrategistState>(() => live.current());

  useEffect(() => live.subscribe(setState), [live]);

  // Abandon anything in flight when the draft screen goes away.
  useEffect(() => () => live.abort(), [live]);

  /*
   * Depends on the brief itself rather than a ref read during render.
   *
   * The brief is a new object on every poll even when nothing changed, so this
   * effect runs often - which is fine, because `update` remembers the boards it
   * has already asked about and returns immediately for an unchanged one. The
   * dedupe belongs there, where it can be tested, not in a dependency array.
   */
  useEffect(() => {
    void live.update(brief);
  }, [live, brief]);

  return state;
}
