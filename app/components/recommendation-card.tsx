'use client';

/**
 * The loudest thing on the screen, and the only thing that says who to draft.
 *
 * One card. The strategist upgrades it in place - a badge, a confidence, three
 * reasons and the argument against itself - and never appears beside it as a
 * competing opinion. When the strategist is thinking, the whole deterministic
 * answer stays exactly where it was; when it fails, one grey sentence appears
 * underneath and nothing else changes.
 */
import type { RecommendationCard } from '@/packages/ui/recommendation';
import type { UsageRecord } from '@/packages/engine/strategist/live';
import { SURVIVAL_COLOR, survivalTone } from '@/packages/ui/theme';
import { Dot, Meter, Pill, PositionTag } from './primitives';

const STATE_BADGE: Record<
  RecommendationCard['state'],
  { label: string; tone: 'accent' | 'neutral' | 'warn' } | null
> = {
  unavailable: null,
  engine: { label: 'Engine pick', tone: 'accent' },
  engine_ai_running: { label: 'Engine pick', tone: 'accent' },
  engine_ai_unavailable: { label: 'Engine pick', tone: 'accent' },
  ai_confirmed: { label: '✓ AI confirmed', tone: 'accent' },
  ai_override: { label: '↗ AI override', tone: 'warn' },
};

export function RecommendationCardView({
  card,
  onOpenPlayer,
  onCompare,
  showSpend,
}: {
  card: RecommendationCard;
  onOpenPlayer: (playerId: string) => void;
  onCompare: (playerIds: string[]) => void;
  /** Development-only cost readout. Never part of the product surface. */
  showSpend: boolean;
}) {
  if (card.state === 'unavailable' || !card.primary) return null;

  const badge = STATE_BADGE[card.state];
  const player = card.primary;
  const tone = survivalTone(player.survival);
  const override = card.state === 'ai_override';

  return (
    <section
      className={`overflow-hidden rounded-2xl border shadow-[0_18px_50px_rgba(0,0,0,0.35)] ${
        override
          ? 'border-[#e0a13c]/45 bg-gradient-to-b from-[#1b1609] to-[#0c1822]'
          : 'border-[#b9ff38]/35 bg-gradient-to-b from-[#101d0d] to-[#0c1822]'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-[#ffffff0f] px-4 py-2.5">
        {badge && <Pill tone={badge.tone}>{badge.label}</Pill>}
        {card.urgency && (
          <Pill
            tone={card.urgency.tone === 'now' ? 'danger' : card.urgency.tone === 'soon' ? 'warn' : 'quiet'}
          >
            {card.urgency.label}
          </Pill>
        )}
        {card.state === 'engine_ai_running' && (
          <span className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.12em] text-[#8fa0aa]">
            <Dot color="#b9ff38" pulse />
            AI strategist analyzing this board…
          </span>
        )}
        {card.aiConfidence !== null && (
          <span className="ml-auto text-[10px] font-black uppercase tracking-[0.12em] text-[#8fa0aa]">
            {card.aiConfidence}% confident
          </span>
        )}
      </div>

      <div className="px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <button
            onClick={() => onOpenPlayer(player.playerId)}
            className="group min-w-0 text-left"
          >
            <h2 className="truncate text-3xl font-black tracking-[-0.045em] text-white group-hover:underline sm:text-[2.6rem] sm:leading-[1.05]">
              {player.name}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <PositionTag position={player.position} />
              <span className="text-[12px] font-bold text-[#8fa0aa]">
                {player.team || 'FA'} · Tier {player.tier}
                {player.playersRemainingInTier > 0 &&
                  ` · ${player.playersRemainingInTier} left in tier`}
                {player.firstSeedRank !== null && ` · First Seed #${player.firstSeedRank}`}
              </span>
            </div>
          </button>

          {player.score !== null && (
            <div className="shrink-0 text-right">
              <p
                className={`text-4xl font-black tabular-nums tracking-[-0.06em] sm:text-5xl ${
                  override ? 'text-[#e0a13c]' : 'text-[#b9ff38]'
                }`}
              >
                {player.score.toFixed(0)}
              </p>
              <p className="text-[9px] font-black uppercase tracking-[0.14em] text-[#60727d]">
                Draft score
              </p>
            </div>
          )}
        </div>

        {player.survival !== null && (
          <div className="mt-4">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[11px] font-bold text-[#8fa0aa]">
                Survives to your next selection
              </p>
              <p
                className="text-sm font-black tabular-nums"
                style={{ color: SURVIVAL_COLOR[tone] }}
              >
                {player.survivalConfidence === 'high' ? '' : '≈'}
                {Math.round(player.survival)}%
              </p>
            </div>
            <div className="mt-1.5">
              <Meter percent={player.survival} color={SURVIVAL_COLOR[tone]} />
            </div>
          </div>
        )}

        {card.strategy && (
          <p className="mt-4 text-[13px] leading-6 text-[#dbe4e9]">{card.strategy}</p>
        )}

        {card.reasons.length > 0 && (
          <ul className="mt-3.5 flex flex-col gap-1.5">
            {card.reasons.map((reason, index) => (
              <li key={`${reason.code ?? index}`} className="flex gap-2 text-[12.5px] leading-6">
                <span className="mt-[2px] shrink-0 text-[#b9ff38]">+</span>
                <span className="text-[#c3d1d9]">
                  {reason.code && (
                    <span className="font-black text-[#e2e8eb]">
                      {reason.code.replace(/_/g, ' ')}
                      {' — '}
                    </span>
                  )}
                  {reason.text}
                </span>
              </li>
            ))}
          </ul>
        )}

        {card.evidence.length > 0 && (
          <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {card.evidence.map((item) => (
              <div
                key={item.label}
                title={item.detail}
                className="rounded-xl border border-[#1e2f3a] bg-[#0a141c] px-2.5 py-2"
              >
                <dt className="text-[9px] font-black uppercase tracking-[0.1em] text-[#5f7280]">
                  {item.label}
                </dt>
                <dd className="mt-0.5 text-[13px] font-black tabular-nums text-[#e2e8eb]">
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {card.enginePick && (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-[#22333e] bg-[#0a141c] px-3 py-2">
            <span className="text-[11px] text-[#7f919c]">
              Engine pick:{' '}
              <button
                onClick={() => onOpenPlayer(card.enginePick!.playerId)}
                className="font-bold text-[#c3d1d9] underline decoration-[#c3d1d9]/30 underline-offset-2"
              >
                {card.enginePick.name}
              </button>
            </span>
            <button
              onClick={() => onCompare([player.playerId, card.enginePick!.playerId])}
              className="ml-auto rounded-lg border border-[#2a3c49] px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-[#a8b4bc] transition hover:border-[#52646f] hover:text-white"
            >
              Compare
            </button>
          </div>
        )}

        {card.counterargument && (
          <details className="mt-3 rounded-xl border border-[#22333e] bg-[#0a141c] p-3">
            <summary className="cursor-pointer text-[10px] font-black uppercase tracking-[0.12em] text-[#71838e]">
              Strongest case against this pick
            </summary>
            <p className="mt-2 text-[12px] leading-6 text-[#8fa0aa]">
              {card.counterargument.objection}
            </p>
            {card.counterargument.answer && (
              <p className="mt-2 text-[12px] leading-6 text-[#dbe4e9]">
                {card.counterargument.answer}
              </p>
            )}
          </details>
        )}

        {card.alternatives.length > 0 && (
          <div className="mt-4 border-t border-[#ffffff0f] pt-3.5">
            <p className="mb-2 text-[9px] font-black uppercase tracking-[0.14em] text-[#5f7280]">
              If not him
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {card.alternatives.map((alternative) => (
                <div
                  key={alternative.playerId}
                  className="rounded-xl border border-[#1e2f3a] bg-[#0a141c] p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <PositionTag position={alternative.position} size="sm" />
                    <button
                      onClick={() => onOpenPlayer(alternative.playerId)}
                      className="min-w-0 flex-1 truncate text-left text-[12.5px] font-bold text-[#e2e8eb] hover:underline"
                    >
                      {alternative.name}
                    </button>
                    {alternative.survival !== null && (
                      <span
                        className="shrink-0 text-[10px] font-black tabular-nums"
                        style={{ color: SURVIVAL_COLOR[survivalTone(alternative.survival)] }}
                      >
                        {Math.round(alternative.survival)}%
                      </span>
                    )}
                  </div>
                  {alternative.reason && (
                    <p className="mt-1.5 line-clamp-2 text-[11px] leading-5 text-[#7f919c]">
                      {alternative.reason}
                    </p>
                  )}
                  <button
                    onClick={() => onCompare([player.playerId, alternative.playerId])}
                    className="mt-2 text-[10px] font-black uppercase tracking-[0.1em] text-[#6d8290] transition hover:text-[#b9ff38]"
                  >
                    Compare
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {card.expectedNextPickPlan && (
          <p className="mt-3.5 text-[11.5px] leading-6 text-[#7f919c]">
            <span className="font-black uppercase tracking-[0.1em] text-[#5f7280]">Then</span>{' '}
            {card.expectedNextPickPlan}
          </p>
        )}

        {card.note && (
          <p className="mt-3 text-[11px] leading-5 text-[#5f7280]">{card.note}</p>
        )}

        {showSpend && <SpendReadout usage={card.usage} />}
      </div>
    </section>
  );
}

/**
 * What the strategist has cost so far.
 *
 * Development only. A drafter has no use for a token count, and this is the
 * first thing to remove once the live spend is understood.
 */
function SpendReadout({ usage }: { usage: UsageRecord | null }) {
  if (!usage || usage.calls === 0) return null;
  return (
    <p className="mt-3 text-[10px] tabular-nums text-[#3f4f5a]">
      {usage.calls} call{usage.calls === 1 ? '' : 's'}
      {usage.repairCalls > 0 ? ` · ${usage.repairCalls} repair` : ''}
      {usage.failures > 0 ? ` · ${usage.failures} failed` : ''}
      {' · $'}
      {usage.estimatedCostUsd.toFixed(3)} est.
    </p>
  );
}

/**
 * The phone version, pinned above the bottom navigation.
 *
 * It exists for one reason: opening the draft board or a player's analysis must
 * never take the recommendation off the screen.
 */
export function RecommendationMiniBar({
  card,
  onOpen,
}: {
  card: RecommendationCard;
  onOpen: () => void;
}) {
  if (!card.primary) return null;
  const override = card.state === 'ai_override';
  return (
    <button
      onClick={onOpen}
      className={`flex w-full items-center gap-2.5 border-b px-3 py-2 text-left ${
        override ? 'border-[#e0a13c]/35 bg-[#171307]' : 'border-[#b9ff38]/25 bg-[#0d1a09]'
      }`}
    >
      <span
        className={`shrink-0 text-[9px] font-black uppercase tracking-[0.1em] ${
          override ? 'text-[#e0a13c]' : 'text-[#b9ff38]'
        }`}
      >
        {card.state === 'ai_confirmed' ? '✓ AI' : override ? '↗ AI' : 'Pick'}
      </span>
      <PositionTag position={card.primary.position} size="sm" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-black text-white">
        {card.primary.name}
      </span>
      {card.primary.survival !== null && (
        <span
          className="shrink-0 text-[11px] font-black tabular-nums"
          style={{ color: SURVIVAL_COLOR[survivalTone(card.primary.survival)] }}
        >
          {Math.round(card.primary.survival)}%
        </span>
      )}
      {card.state === 'engine_ai_running' && <Dot color="#b9ff38" pulse />}
    </button>
  );
}
