/**
 * The sign-in surface, decided away from the markup.
 *
 * Which screen is showing, what is wrong with what has been typed, and what to
 * say when the server refuses. All of it is a pure function of the form and the
 * response, which is what lets the awkward cases - a password that is long
 * enough for the browser and too short for the server, an email that is already
 * registered - be tested without a browser or a database.
 *
 * One rule shapes the error messages: never confirm whether an address has an
 * account. "If that address is registered, a link is on its way" is the same
 * sentence either way, and the difference between it and "no such user" is an
 * enumeration attack.
 */

export type AuthScreen =
  /**
   * The two products, before anybody types anything.
   *
   * The default for a visitor with no link telling us otherwise, because a
   * signup that does not first say what Basic and Pro are is a signup that
   * silently means Basic - which is the thing this screen exists to prevent.
   */
  | 'plans'
  | 'sign_in'
  | 'sign_up'
  | 'forgot_password'
  | 'reset_password'
  | 'sent';

/** Better Auth's own minimum. Kept here so the form can say so before posting. */
export const MIN_PASSWORD_LENGTH = 12;

export interface SignUpForm {
  name: string;
  email: string;
  password: string;
}

export interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
}

/**
 * Deliberately permissive.
 *
 * A regular expression cannot decide whether an address exists, and every one
 * that tries rejects somebody's real address. This catches the typo - no @, no
 * domain, a stray space - and leaves the rest to the verification email, which
 * is the only thing that actually knows.
 */
export function emailLooksValid(email: string): boolean {
  const trimmed = email.trim();
  if (trimmed.length < 3 || /\s/.test(trimmed)) return false;
  const at = trimmed.indexOf('@');
  return at > 0 && at < trimmed.length - 1 && trimmed.lastIndexOf('@') === at;
}

export function validateSignUp(form: SignUpForm): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.name.trim()) errors.name = 'Tell us what to call you.';
  if (!emailLooksValid(form.email)) errors.email = 'That does not look like an email address.';
  if (form.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return errors;
}

export function validateSignIn(form: { email: string; password: string }): FieldErrors {
  const errors: FieldErrors = {};
  if (!emailLooksValid(form.email)) errors.email = 'That does not look like an email address.';
  if (!form.password) errors.password = 'Enter your password.';
  return errors;
}

export function validateNewPassword(password: string, confirmation: string): FieldErrors {
  const errors: FieldErrors = {};
  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  } else if (password !== confirmation) {
    errors.password = 'Those two do not match.';
  }
  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * What to show a person when the server says no.
 *
 * Better Auth returns codes; a code is not an instruction. Anything unrecognised
 * falls through to a sentence that is true of every failure rather than to the
 * raw code, which would leak implementation detail into a login box.
 */
export function describeAuthError(code: string | null | undefined, fallback?: string): string {
  switch (code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
    case 'INVALID_PASSWORD':
      // One message for both, on purpose: saying which was wrong tells an
      // attacker which addresses have accounts.
      return 'That email and password do not match.';
    case 'USER_ALREADY_EXISTS':
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
      return 'There is already an account with that address. Try signing in.';
    case 'EMAIL_NOT_VERIFIED':
      return 'Confirm your email address first - check your inbox for the link.';
    case 'PASSWORD_TOO_SHORT':
      return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    case 'INVALID_TOKEN':
    case 'TOKEN_EXPIRED':
      return 'That link has expired. Ask for a new one.';
    case 'FAILED_TO_CREATE_USER':
      return 'The account could not be created. Try again in a moment.';
    default:
      return fallback?.trim() || 'That did not work. Try again in a moment.';
  }
}

/** Identical whether or not the address exists. That is the point. */
export const RESET_REQUESTED_MESSAGE =
  'If that address has an account, a reset link is on its way.';

export const VERIFICATION_SENT_MESSAGE =
  'Check your inbox for a link to confirm your address.';

/**
 * Which screen a URL is asking for.
 *
 * Better Auth's reset email links back with a `token` query parameter, so the
 * presence of one is what decides between "ask for a link" and "choose a new
 * password".
 */
export function screenForUrl(search: string): { screen: AuthScreen; token: string | null } {
  const params = new URLSearchParams(search);
  const token = params.get('token');
  if (token) return { screen: 'reset_password', token };
  const requested = params.get('auth');
  if (requested === 'sign_in') return { screen: 'sign_in', token: null };
  if (requested === 'sign_up') return { screen: 'sign_up', token: null };
  if (requested === 'forgot') return { screen: 'forgot_password', token: null };
  /*
   * Pricing first. A returning customer reaches sign-in in one click from
   * there, and a new one cannot arrive inside the product without having been
   * shown what the two versions are.
   */
  return { screen: 'plans', token: null };
}
