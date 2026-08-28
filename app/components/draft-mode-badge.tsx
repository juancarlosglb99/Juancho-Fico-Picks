'use client';

/**
 * "Am I getting the AI, or not?" - answered without having to wonder.
 *
 * Two pieces. The badge lives in the top bar for the whole draft, so the answer
 * is never more than a glance away. The prompt appears once, before anything is
 * spent, and is the only place a credit is ever committed.
 *
 * Both read their words from `packages/ui/draft-mode`, which is where the rules
 * about what each state says actually live. Neither decides anything: the
 * server refuses or allows, and this draws the result.
 *
 * Accessibility: the state is carried by words in every case. The dot is a
 * second signal, never the only one.
 */
import type { DraftMode } from '@/packages/ui/draft-mode';
import { creditPrompt } from '@/packages/ui/draft-mode';
import { Panel } from './primitives';

const TONE: Record<DraftMode['kind'], { dot: string; text: string; border: string }> = {
  standard: { dot: '#7f919c', text: '#b8c3c9', border: '#2a3b46' },
  pro_standard: { dot: '#e0a13c', text: '#e8f0f4', border: '#3a3320' },
  ai: { dot: '#b9ff38', text: '#dfffb0', border: '#3d5a1f' },
  ai_admin: { dot: '#b9ff38', text: '#dfffb0', border: '#3d5a1f' },
};

export function DraftModeBadge({ mode }: { mode: DraftMode }) {
  const tone = TONE[mode.kind];
  return (
    <div
      className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5"
      style={{ borderColor: tone.border }}
      title={[mode.label, mode.detail, mode.credits].filter(Boolean).join(' · ')}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${mode.aiActive ? 'animate-pulse' : ''}`}
        style={{ backgroundColor: tone.dot }}
      />
      <div className="min-w-0 leading-tight">
        {/*
          Two labels, one meaning. The short one runs on a phone, where mobile
          QA found the full text pushing "YOUR PICK / ROUND 5/15" out of the
          bar - the mode crowding out whose pick it is, which matters more.
          Both answer the only question this badge exists for.
        */}
        <p
          className="truncate text-[10px] font-black uppercase tracking-[0.1em] sm:hidden"
          style={{ color: tone.text }}
        >
          {mode.shortLabel}
        </p>
        <p
          className="hidden truncate text-[10px] font-black uppercase tracking-[0.1em] sm:block"
          style={{ color: tone.text }}
        >
          {mode.label}
        </p>
        <p className="hidden truncate text-[10px] font-semibold text-[#7f919c] sm:block">
          {mode.credits ?? mode.detail}
        </p>
      </div>
    </div>
  );
}

/**
 * The one question asked before a credit is spent.
 *
 * Shown to a Pro drafter who has not chosen yet. Declining is a first-class
 * answer, not a dismissal - a Pro customer running a casual mock should be able
 * to say "not this one" and keep their credits.
 */
export function CreditPromptBanner({
  creditsRemaining,
  busy,
  onUseAi,
  onStandard,
}: {
  creditsRemaining: number | null;
  busy: boolean;
  onUseAi: () => void;
  onStandard: () => void;
}) {
  const prompt = creditPrompt(creditsRemaining);
  return (
    <Panel className="border-[#3a3320] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[14px] font-black tracking-[-0.02em]">{prompt.question}</p>
          <p className="mt-1 text-[12px] font-bold text-[#e0a13c]">{prompt.remaining}</p>
          <p className="mt-1.5 max-w-xl text-[12.5px] leading-6 text-[#a3b1ba]">
            {prompt.explanation}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onStandard}
            disabled={busy}
            className="rounded-lg border border-[#2a3b46] bg-[#0d1922] px-3.5 py-2.5 text-[12px] font-black text-[#f7f8f2] transition hover:border-[#3c5261] disabled:opacity-50"
          >
            {prompt.decline}
          </button>
          <button
            type="button"
            onClick={onUseAi}
            disabled={busy}
            className="rounded-lg bg-[#b9ff38] px-3.5 py-2.5 text-[12px] font-black text-[#08120a] transition hover:bg-[#c9ff5f] disabled:opacity-50"
          >
            {busy ? 'Switching on…' : prompt.confirm}
          </button>
        </div>
      </div>
    </Panel>
  );
}
