import { runMonteCarloCandidateComparison, type SimulationInput } from './simulation';

export interface DraftBacktestCase {
  id: string;
  input: SimulationInput;
  candidatePlayerIds: string[];
  actualPlayerId?: string;
}

export function runDraftBacktest(cases: DraftBacktestCase[]) {
  return cases.map((testCase, index) => {
    const comparison = runMonteCarloCandidateComparison(
      testCase.input,
      testCase.candidatePlayerIds,
      { simulations: 40, seed: 91_000 + index * 10_000 },
    );
    const recommendedPlayerId = comparison.candidates[0]?.playerId ?? null;
    return {
      id: testCase.id,
      recommendedPlayerId,
      actualPlayerId: testCase.actualPlayerId ?? null,
      matchedActual: testCase.actualPlayerId
        ? recommendedPlayerId === testCase.actualPlayerId
        : null,
      comparison,
    };
  });
}
