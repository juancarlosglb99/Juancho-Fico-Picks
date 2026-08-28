'use client';

/**
 * The two products, side by side.
 *
 * Used in both places a person meets them: the pricing page a signed-out
 * visitor lands on, and the chooser a newly-registered account sees before it
 * is activated. One component for both, because they must describe the same
 * thing in the same words - and the content comes from `packages/ui/plans`, so
 * neither is where the wording actually lives.
 *
 * The Pro card is marked with words, not just a colour: "Most complete" is
 * readable by somebody who cannot see that its border is lime.
 */
import { PLAN_OFFERS, type PlanOffer, type RequestedPlan } from '@/packages/ui/plans';
import { Panel } from './primitives';

export function PlanCards({
  onChoose,
  busy = null,
  selected = null,
  compact = false,
}: {
  onChoose: (plan: RequestedPlan) => void;
  /** The plan whose button is mid-request, if any. */
  busy?: RequestedPlan | null;
  /** Already chosen, so the button reads differently. */
  selected?: RequestedPlan | null;
  compact?: boolean;
}) {
  return (
    <div className={`grid gap-4 ${compact ? '' : 'md:grid-cols-2'}`}>
      {PLAN_OFFERS.map((offer) => (
        <PlanCard
          key={offer.id}
          offer={offer}
          onChoose={onChoose}
          busy={busy === offer.id}
          disabled={busy !== null && busy !== offer.id}
          selected={selected === offer.id}
        />
      ))}
    </div>
  );
}

function PlanCard({
  offer,
  onChoose,
  busy,
  disabled,
  selected,
}: {
  offer: PlanOffer;
  onChoose: (plan: RequestedPlan) => void;
  busy: boolean;
  disabled: boolean;
  selected: boolean;
}) {
  const isPro = offer.id === 'pro';
  return (
    <Panel
      className={`flex flex-col p-5 ${
        isPro ? 'border-[#3d5a1f]' : ''
      } ${selected ? 'ring-1 ring-[#b9ff38]' : ''}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#5f7280]">
          {offer.label}
        </p>
        {isPro && (
          /* Words, not a colour. This is the only "highlight" on the card. */
          <span className="rounded-full border border-[#3d5a1f] bg-[#101c08] px-2 py-0.5 text-[9.5px] font-black uppercase tracking-[0.12em] text-[#b9ff38]">
            Most complete
          </span>
        )}
      </div>

      <h3 className="mt-2 text-[19px] font-black leading-tight tracking-[-0.03em]">
        {offer.productName}
      </h3>
      <p className="mt-1.5 text-[26px] font-black tracking-[-0.04em]">{offer.price}</p>
      <p className="mt-2 text-[13px] leading-6 text-[#a3b1ba]">{offer.summary}</p>

      <p className="mt-5 text-[10px] font-black uppercase tracking-[0.14em] text-[#5f7280]">
        {offer.featuresHeading}
      </p>
      <ul className="mt-2.5 flex flex-col gap-1.5">
        {offer.features.map((feature) => (
          <li key={feature} className="flex gap-2 text-[13px] leading-6 text-[#dfe6ea]">
            <span aria-hidden className="text-[#5f7280]">
              ·
            </span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={() => onChoose(offer.id)}
        disabled={busy || disabled}
        className={`mt-6 w-full rounded-xl px-4 py-3 text-[13px] font-black tracking-[-0.01em] transition disabled:opacity-50 ${
          isPro
            ? 'bg-[#b9ff38] text-[#08120a] hover:bg-[#c9ff5f]'
            : 'border border-[#2a3b46] bg-[#0d1922] text-[#f7f8f2] hover:border-[#3c5261]'
        }`}
      >
        {busy ? 'Saving…' : selected ? `${offer.label} selected` : offer.cta}
      </button>
    </Panel>
  );
}

/** The heading above the two cards. Same words wherever they are shown. */
export function PlanCardsIntro({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="mb-6">
      <h2 className="text-2xl font-black leading-tight tracking-[-0.04em]">
        {signedIn ? 'Which version do you want?' : 'Two ways to draft.'}
      </h2>
      <p className="mt-2 max-w-2xl text-[14px] leading-7 text-[#a3b1ba]">
        {signedIn
          ? 'Choosing does not charge you and does not switch anything on - it tells us what to set up. Payment is arranged privately.'
          : 'Both give you the full draft engine. Pro adds a strategist that studies your board on its own and argues with the recommendation.'}
      </p>
    </div>
  );
}
