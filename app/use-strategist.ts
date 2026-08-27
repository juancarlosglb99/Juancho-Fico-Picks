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
import { useEffect, useMemo, useRef, useState } from 'react';
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
   * Keyed on the board fingerprint rather than the brief object.
   *
   * The brief is rebuilt on every poll - eight hundred milliseconds apart -
   * and is a new object each time even when nothing has changed. Depending on
   * the object would restart the request on every tick.
   */
  const fingerprint = brief?.state.boardFingerprint ?? null;
  const latest = useRef(brief);
  latest.current = brief;

  useEffect(() => {
    void live.update(latest.current);
  }, [live, fingerprint]);

  return state;
}
