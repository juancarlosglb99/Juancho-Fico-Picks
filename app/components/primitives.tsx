'use client';

/**
 * The small shared pieces, so six components cannot each invent a panel.
 *
 * Nothing here knows anything about drafting. If a piece needs a rule about
 * fantasy football to decide what it renders, that rule belongs in
 * `packages/ui` where it can be tested without a browser.
 */
import type { ReactNode } from 'react';
import { positionPalette } from '@/packages/ui/theme';

export function LoadingMark({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent ${className}`}
    />
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#b9ff38] text-xs font-black tracking-[-0.08em] text-[#071019]">
        JF
      </span>
      {!compact && (
        <div className="leading-tight">
          <p className="text-[13px] font-extrabold uppercase tracking-[0.1em]">Juancho-Fico</p>
          <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[#7d8d98]">Picks</p>
        </div>
      )}
    </div>
  );
}

/**
 * A position, always as letters AND colour.
 *
 * The letters are not decoration. Colour alone is unreadable for a significant
 * minority of drafters, and this component is the reason no cell in the product
 * ever relies on the swatch by itself.
 */
export function PositionTag({
  position,
  size = 'md',
}: {
  position: string | null | undefined;
  size?: 'sm' | 'md';
}) {
  const palette = positionPalette(position);
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded font-black uppercase tracking-[0.06em] ${
        size === 'sm' ? 'min-w-7 px-1 py-0.5 text-[9px]' : 'min-w-9 px-1.5 py-1 text-[10px]'
      }`}
      style={{ color: palette.fg, background: palette.bg, border: `1px solid ${palette.border}` }}
    >
      {position ?? '—'}
    </span>
  );
}

export function Panel({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
      className={`rounded-2xl border border-[#1e2f3a] bg-[#0c1822] ${padded ? 'p-4' : ''} ${className}`}
    >
      {children}
    </section>
  );
}

export function PanelTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-[10px] font-black uppercase tracking-[0.16em] text-[#71838e]">
        {children}
      </h2>
      {action}
    </div>
  );
}

/** A 0-100 track. Used for survival, tier fill and confidence alike. */
export function Meter({
  percent,
  color,
  height = 6,
  track = '#1a2a34',
}: {
  percent: number;
  color: string;
  height?: number;
  track?: string;
}) {
  return (
    <div
      className="w-full overflow-hidden rounded-full"
      style={{ height, background: track }}
      role="presentation"
    >
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.max(0, Math.min(100, percent))}%`, background: color }}
      />
    </div>
  );
}

export function Pill({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'warn' | 'danger' | 'quiet';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-[#13232c] text-[#b8c3c9] border-[#24384470]',
    accent: 'bg-[#b9ff38]/12 text-[#b9ff38] border-[#b9ff38]/25',
    warn: 'bg-[#e0a13c]/12 text-[#e5bd70] border-[#e0a13c]/25',
    danger: 'bg-[#ff7a59]/12 text-[#ff9a80] border-[#ff7a59]/25',
    quiet: 'bg-transparent text-[#60727d] border-[#22333e]',
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.1em] ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Dot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${pulse ? 'animate-pulse' : ''}`}
      style={{ background: color }}
    />
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="py-3 text-[11px] leading-5 text-[#5f7280]">{children}</p>;
}

/**
 * Something worth saying that is not something going wrong.
 *
 * A finished draft is not an error, and rendering it in the same red as a
 * failed data source teaches a drafter to ignore red.
 */
export function Notice({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-[#22333e] bg-[#0a141c] px-4 py-2.5 text-[12px] font-semibold text-[#8fa0aa]">
      {message}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-[#713c35] bg-[#2a1717] px-4 py-3 text-sm font-semibold text-[#ffb4a7]"
    >
      {message}
    </div>
  );
}

/**
 * A modal surface: a right-hand drawer on a desktop, a bottom sheet on a phone.
 *
 * The sheet deliberately stops short of the top of the screen. The status bar
 * and the recommendation strip live up there, and the one thing this product
 * promises is that opening something else never hides what to draft.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-[#02080c]/70 backdrop-blur-[2px]"
      />
      <div className="relative ml-auto flex h-full w-full flex-col border-l border-[#22333e] bg-[#0a141c] shadow-[0_0_80px_rgba(0,0,0,0.6)] max-lg:mt-[7.5rem] max-lg:h-[calc(100%-7.5rem)] max-lg:rounded-t-2xl max-lg:border-l-0 max-lg:border-t lg:max-w-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-[#1c2b35] px-4 py-3 lg:px-5">
          <div className="min-w-0 flex-1">{title}</div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg border border-[#2a3c49] px-2.5 py-1.5 text-[11px] font-bold text-[#a8b4bc] transition hover:border-[#52646f] hover:text-white"
          >
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 lg:px-5">
          {children}
        </div>
        {footer && <div className="border-t border-[#1c2b35] px-4 py-3 lg:px-5">{footer}</div>}
      </div>
    </div>
  );
}

/** A segmented control. One selected option, always visibly selected. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (next: T) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div className="flex w-fit gap-0.5 rounded-lg border border-[#22333e] bg-[#0a141c] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
          className={`rounded-md font-black uppercase tracking-[0.08em] transition ${
            size === 'sm' ? 'px-2 py-1 text-[9px]' : 'px-3 py-1.5 text-[10px]'
          } ${
            option.value === value
              ? 'bg-[#b9ff38] text-[#071019]'
              : 'text-[#7f919c] hover:text-[#dfe6e9]'
          }`}
        >
          {option.label}
          {option.count !== undefined && (
            <span className="ml-1.5 font-bold opacity-60">{option.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
