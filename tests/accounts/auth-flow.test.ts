import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  RESET_REQUESTED_MESSAGE,
  describeAuthError,
  emailLooksValid,
  hasErrors,
  screenForUrl,
  validateNewPassword,
  validateSignIn,
  validateSignUp,
} from '../../packages/ui/auth-flow';

describe('what counts as an email address', () => {
  it('accepts ordinary ones, including the awkward real ones', () => {
    for (const email of [
      'a@b.co',
      'juan+fantasy@example.com',
      "o'brien@example.co.uk",
      'user_name@sub.domain.example',
    ]) {
      expect(emailLooksValid(email)).toBe(true);
    }
  });

  it('catches the typo without trying to be the authority', () => {
    for (const email of ['', 'nope', 'no@', '@nope', 'two@at@signs', 'has space@x.com']) {
      expect(emailLooksValid(email)).toBe(false);
    }
  });
});

describe('form validation', () => {
  it('asks for everything a sign-up needs', () => {
    const errors = validateSignUp({ name: '', email: 'bad', password: 'short' });
    expect(errors.name).toBeTruthy();
    expect(errors.email).toBeTruthy();
    expect(errors.password).toContain(String(MIN_PASSWORD_LENGTH));
    expect(hasErrors(errors)).toBe(true);
  });

  it('passes a good one', () => {
    const errors = validateSignUp({
      name: 'Juan',
      email: 'juan@example.com',
      password: 'a-long-enough-password',
    });
    expect(hasErrors(errors)).toBe(false);
  });

  it('does not judge the password on sign-in, only its absence', () => {
    // The rules may have changed since the account was made; the server decides.
    expect(hasErrors(validateSignIn({ email: 'juan@example.com', password: 'x' }))).toBe(false);
    expect(validateSignIn({ email: 'juan@example.com', password: '' }).password).toBeTruthy();
  });

  it('checks a new password for length before checking it matches', () => {
    expect(validateNewPassword('short', 'different').password).toContain('12');
    expect(validateNewPassword('a-long-enough-password', 'something-else').password).toBe(
      'Those two do not match.',
    );
    expect(hasErrors(validateNewPassword('a-long-enough-password', 'a-long-enough-password'))).toBe(
      false,
    );
  });
});

describe('what the screen says when the server refuses', () => {
  it('never reveals whether an address has an account', () => {
    // The same sentence for a wrong password and an address that does not exist.
    expect(describeAuthError('INVALID_EMAIL_OR_PASSWORD')).toBe(
      'That email and password do not match.',
    );
    expect(describeAuthError('INVALID_PASSWORD')).toBe(
      describeAuthError('INVALID_EMAIL_OR_PASSWORD'),
    );
    expect(RESET_REQUESTED_MESSAGE).toContain('If that address has an account');
  });

  it('translates the codes a person can act on', () => {
    expect(describeAuthError('USER_ALREADY_EXISTS')).toContain('signing in');
    expect(describeAuthError('EMAIL_NOT_VERIFIED')).toContain('Confirm your email');
    expect(describeAuthError('TOKEN_EXPIRED')).toContain('expired');
  });

  it('never shows a raw code to a person', () => {
    const unknown = describeAuthError('SOME_INTERNAL_CODE_42');
    expect(unknown).not.toContain('SOME_INTERNAL_CODE_42');
    expect(unknown).toBe('That did not work. Try again in a moment.');
    // A server-supplied sentence is preferred over the generic one.
    expect(describeAuthError(null, 'The server is restarting.')).toBe('The server is restarting.');
    expect(describeAuthError(null, '   ')).toBe('That did not work. Try again in a moment.');
  });
});

describe('which screen a link asks for', () => {
  it('sends a reset link to the choose-a-password screen', () => {
    expect(screenForUrl('?token=abc123')).toEqual({ screen: 'reset_password', token: 'abc123' });
  });

  it('defaults to signing in', () => {
    expect(screenForUrl('')).toEqual({ screen: 'sign_in', token: null });
    expect(screenForUrl('?auth=sign_up').screen).toBe('sign_up');
    expect(screenForUrl('?auth=forgot').screen).toBe('forgot_password');
  });
});
