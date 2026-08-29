/**
 * The browser half of the strategist call.
 *
 * Posts the prepared payload to the server route and hands back exactly what it
 * returned. No interpretation happens here: the caller stamps the advice with
 * its own board and runs the guardrails, because those need the brief and this
 * only needs the network.
 */
import type {
  StrategistTransport,
  StrategistTransportResult,
} from '../packages/engine/strategist/live';

export class HttpStrategistTransport implements StrategistTransport {
  constructor(private readonly endpoint = '/api/strategist') {}

  async advise(
    input: Parameters<StrategistTransport['advise']>[0],
  ): Promise<StrategistTransportResult> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        context: input.context,
        boardPlayerIds: input.boardPlayerIds,
        state: input.state,
        leagueId: input.leagueId ?? null,
        isMock: input.isMock ?? false,
      }),
      signal: input.signal,
    });

    if (!response.ok) {
      // A failed request is not a broken draft; it is a call that did not land.
      return {
        response: null,
        problems: [],
        state: input.state,
        model: 'unknown',
        usage: null,
        attempts: 0,
        latencyMs: 0,
        error:
          response.status === 503
            ? 'The strategist is unavailable on this server.'
            : `The strategist request failed (${response.status}).`,
      };
    }

    return (await response.json()) as StrategistTransportResult;
  }
}
