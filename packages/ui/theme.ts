/**
 * The visual vocabulary, kept out of the components.
 *
 * Two things live here rather than in JSX. Position colour, because a draft
 * board is read by shape and colour before it is read by word, and the same
 * position must be the same colour in the board, the pool, the roster and the
 * drawer - which will not happen if six components each pick a hex. And the
 * small formatters, because "12%" and "≈12%" mean different things and the
 * difference is a product decision, not a component's business.
 *
 * Colour is never the only signal. Every position swatch in this product is
 * rendered next to the position's own letters, which is what makes the board
 * usable for the eight per cent of men who cannot separate the red from the
 * green.
 */

export type PositionKey = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DEF' | 'FLEX' | 'BN' | 'OTHER';

export interface PositionPalette {
  /** Text and swatch colour. */
  fg: string;
  /** A translucent fill that survives on both panel greys. */
  bg: string;
  border: string;
}

/**
 * Hues chosen to sit beside the brand lime without competing with it.
 *
 * The lime is reserved: it means "this is the recommendation" everywhere in the
 * product, so no position may claim it. These six are separated in hue and in
 * lightness so a printed or desaturated screenshot still distinguishes them.
 */
export const POSITION_PALETTE: Record<PositionKey, PositionPalette> = {
  QB: { fg: '#f0776a', bg: 'rgba(240,119,106,0.14)', border: 'rgba(240,119,106,0.34)' },
  RB: { fg: '#4fc98a', bg: 'rgba(79,201,138,0.14)', border: 'rgba(79,201,138,0.34)' },
  WR: { fg: '#54a9f0', bg: 'rgba(84,169,240,0.14)', border: 'rgba(84,169,240,0.34)' },
  TE: { fg: '#e0a13c', bg: 'rgba(224,161,60,0.14)', border: 'rgba(224,161,60,0.34)' },
  K: { fg: '#a58cf0', bg: 'rgba(165,140,240,0.14)', border: 'rgba(165,140,240,0.32)' },
  DEF: { fg: '#7f9aa8', bg: 'rgba(127,154,168,0.14)', border: 'rgba(127,154,168,0.32)' },
  FLEX: { fg: '#c9b4f5', bg: 'rgba(201,180,245,0.12)', border: 'rgba(201,180,245,0.3)' },
  BN: { fg: '#7f919c', bg: 'rgba(127,145,156,0.10)', border: 'rgba(127,145,156,0.26)' },
  OTHER: { fg: '#8fa0aa', bg: 'rgba(143,160,170,0.12)', border: 'rgba(143,160,170,0.28)' },
};

export function positionPalette(position: string | null | undefined): PositionPalette {
  const key = (position ?? '').toUpperCase();
  if (key in POSITION_PALETTE) return POSITION_PALETTE[key as PositionKey];
  if (key === 'SUPER_FLEX' || key === 'SF') return POSITION_PALETTE.FLEX;
  if (key === 'DST' || key === 'D/ST') return POSITION_PALETTE.DEF;
  return POSITION_PALETTE.OTHER;
}

/** The slot labels a person recognises, from the engine's own slot keys. */
export function slotLabel(slot: string): string {
  if (slot === 'SUPER_FLEX') return 'SFLEX';
  if (slot === 'DEF') return 'DEF';
  return slot;
}

/**
 * A probability, with its uncertainty visible.
 *
 * The engine reports a confidence alongside every survival number and the
 * difference is worth a character: `72%` is counted from simulated futures
 * against a published board, `≈72%` is an estimate from our own projection
 * order. Rounding them into the same string throws that away.
 */
export function formatSurvival(
  probability: number | null | undefined,
  confidence?: string | null,
): string {
  if (probability === null || probability === undefined) return '—';
  const prefix = confidence === 'high' ? '' : '≈';
  return `${prefix}${Math.round(probability)}%`;
}

/** How alarming a survival number is. Thresholds match the recommendation card. */
export function survivalTone(probability: number | null | undefined): 'gone' | 'risky' | 'safe' | 'unknown' {
  if (probability === null || probability === undefined) return 'unknown';
  if (probability <= 35) return 'gone';
  if (probability <= 70) return 'risky';
  return 'safe';
}

export const SURVIVAL_COLOR: Record<'gone' | 'risky' | 'safe' | 'unknown', string> = {
  gone: '#ff7a59',
  risky: '#e0a13c',
  safe: '#b9ff38',
  unknown: '#7f919c',
};

/** Points, to one decimal, without a trailing `.0` on a whole number. */
export function formatPoints(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatSigned(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  const body = Number.isInteger(rounded) ? String(Math.abs(rounded)) : Math.abs(rounded).toFixed(1);
  if (rounded > 0) return `+${body}`;
  if (rounded < 0) return `−${body}`;
  return '0';
}

/** `must_take_now` reads badly on a screen; this is what a person would say. */
export function urgencyLabel(urgency: string | null | undefined): string | null {
  if (urgency === 'must_take_now') return 'Take him now';
  if (urgency === 'likely_to_return') return 'Likely to come back';
  if (urgency === 'neutral') return 'Timing is not the issue';
  return null;
}

/**
 * `half_ppr` is a key, not a label. This is what a person should read.
 *
 * The acronym list is not cosmetic: "Full Ppr" beside real projections reads as
 * a bug, and a screen that looks careless about the easy things is not believed
 * about the hard ones.
 */
const ACRONYMS = new Set(['ppr', 'adp', 'qb', 'rb', 'wr', 'te', 'def', 'dst', 'sf', 'ir', 'nfl']);

export function displayEnum(value: string): string {
  return value
    .replaceAll('_', ' ')
    .split(' ')
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

/** Fractional starting slots are a flex-sharing artefact, not a countable thing. */
export function formatSlots(value: number): string {
  const rounded = Math.round(value);
  return String(Math.max(0, rounded));
}
