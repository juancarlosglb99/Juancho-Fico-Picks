'use client';

/**
 * Sign in, sign up, and the two password screens.
 *
 * One component for all four because they are one flow, and moving between them
 * should not feel like navigating. Every decision it makes - which screen, what
 * is wrong with the form, what to say when the server refuses - comes from
 * `packages/ui/auth-flow`, which is tested without a browser.
 *
 * The one thing this deliberately does NOT do is tell you whether an address
 * has an account. A wrong password and an unknown address get the same
 * sentence, and asking for a reset link gets the same confirmation either way.
 */
import { useState } from 'react';
import {
  MIN_PASSWORD_LENGTH,
  RESET_REQUESTED_MESSAGE,
  VERIFICATION_SENT_MESSAGE,
  describeAuthError,
  hasErrors,
  validateNewPassword,
  validateSignIn,
  validateSignUp,
  type AuthScreen,
  type FieldErrors,
} from '@/packages/ui/auth-flow';
import { requestPasswordReset, resetPassword, signIn, signUp } from '../auth-client';
import { PlanCards, PlanCardsIntro } from './plan-cards';
import { offerFor, type RequestedPlan } from '@/packages/ui/plans';
import { Brand, ErrorBanner, LoadingMark, Panel } from './primitives';

interface Result {
  error?: { code?: string; message?: string } | null;
}

export function AuthScreenView({
  initialScreen,
  resetToken,
  onSignedIn,
}: {
  initialScreen: AuthScreen;
  resetToken: string | null;
  onSignedIn: () => void;
}) {
  const [screen, setScreen] = useState<AuthScreen>(initialScreen);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * What they picked on the pricing page, carried into signup and posted after
   * the account exists. Held here rather than in the URL so it survives a typo
   * in the form, and it grants nothing either way - the server records it as a
   * request against the new account and an admin still has to activate it.
   */
  const [chosenPlan, setChosenPlan] = useState<RequestedPlan | null>(null);

  const go = (next: AuthScreen) => {
    setScreen(next);
    setErrors({});
    setFailure(null);
    setMessage(null);
  };

  const run = async (
    validation: FieldErrors,
    action: () => Promise<Result | void>,
    onSuccess: () => void,
  ) => {
    setErrors(validation);
    setFailure(null);
    if (hasErrors(validation)) return;
    setBusy(true);
    try {
      const result = (await action()) as Result | undefined;
      if (result?.error) {
        setFailure(describeAuthError(result.error.code, result.error.message));
        return;
      }
      onSuccess();
    } catch (error) {
      setFailure(describeAuthError(null, error instanceof Error ? error.message : undefined));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#071019] text-[#f7f8f2]">
      <header className="border-b border-[#1c2b35] px-5 py-4">
        <div className="mx-auto w-full max-w-5xl">
          <Brand />
        </div>
      </header>

      {screen === 'plans' && (
        /*
         * Full width, and shown before anything can be typed. A visitor cannot
         * reach the signup form without passing this, which is the entire point:
         * signing up must never quietly mean "Basic".
         */
        <div className="mx-auto w-full max-w-4xl px-5 py-10">
          <PlanCardsIntro signedIn={false} />
          <PlanCards
            onChoose={(plan) => {
              setChosenPlan(plan);
              go('sign_up');
            }}
            selected={chosenPlan}
          />
          <p className="mt-6 text-[13px] leading-6 text-[#7f919c]">
            Payment is arranged privately while we are in beta - choosing a plan
            here does not charge you.{' '}
            <button
              type="button"
              onClick={() => go('sign_in')}
              className="font-bold text-[#b9ff38] underline-offset-2 hover:underline"
            >
              Already have an account?
            </button>
          </p>
        </div>
      )}

      <div
        className={`mx-auto w-full max-w-5xl items-start gap-10 px-5 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] ${
          screen === 'plans' ? 'hidden' : 'grid'
        }`}
      >
        <div className="hidden lg:block">
          <h1 className="max-w-md text-4xl font-black leading-[1.05] tracking-[-0.05em]">
            Know who to draft
            <span className="block text-[#7f919c]">and who can wait.</span>
          </h1>
          <p className="mt-5 max-w-md text-[15px] leading-7 text-[#a3b1ba]">
            An account keeps your Sleeper connection, your draft history and your
            AI credits together. The draft engine itself is unlimited on every
            plan.
          </p>
        </div>

        <Panel className="p-5">
          {failure && (
            <div className="mb-4">
              <ErrorBanner message={failure} />
            </div>
          )}
          {message && (
            <p className="mb-4 rounded-xl border border-[#2f4a34] bg-[#0a1710] px-3 py-2.5 text-[12.5px] leading-5 text-[#b9ff38]">
              {message}
            </p>
          )}

          {screen === 'sign_in' && (
            <Form
              title="Sign in"
              submit="Sign in"
              busy={busy}
              onSubmit={() =>
                run(
                  validateSignIn({ email, password }),
                  () => signIn.email({ email, password }),
                  onSignedIn,
                )
              }
              footer={
                <>
                  <Link onClick={() => go('sign_up')}>Create an account</Link>
                  <Link onClick={() => go('forgot_password')}>Forgot your password?</Link>
                </>
              }
            >
              <Field label="Email" type="email" value={email} onChange={setEmail} error={errors.email} autoComplete="email" />
              <Field label="Password" type="password" value={password} onChange={setPassword} error={errors.password} autoComplete="current-password" />
            </Form>
          )}

          {screen === 'sign_up' && (
            <Form
              title="Create an account"
              submit="Create account"
              busy={busy}
              onSubmit={() =>
                run(
                  validateSignUp({ name, email, password }),
                  () => signUp.email({ name, email, password }),
                  () => {
                    /*
                     * Recorded straight after the account exists, because this
                     * is the only moment we still hold the choice. It is a
                     * request, not a grant - the account stays pending until an
                     * admin activates it - so a failure here costs a label on
                     * the pending screen, never access.
                     */
                    if (chosenPlan) {
                      void fetch('/api/account/plan', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({ plan: chosenPlan }),
                      })
                        .catch(() => null)
                        .finally(() => onSignedIn());
                      setMessage(VERIFICATION_SENT_MESSAGE);
                      return;
                    }
                    setMessage(VERIFICATION_SENT_MESSAGE);
                    onSignedIn();
                  },
                )
              }
              footer={
                <>
                  <Link onClick={() => go('sign_in')}>Already have an account?</Link>
                  <Link onClick={() => go('plans')}>Compare plans</Link>
                </>
              }
            >
              {chosenPlan && (
                <p className="mb-1 rounded-xl border border-[#2a3b46] bg-[#0d1922] px-3 py-2.5 text-[12.5px] leading-5 text-[#a3b1ba]">
                  <span className="font-black text-[#f7f8f2]">
                    {offerFor(chosenPlan).label} · {offerFor(chosenPlan).price}
                  </span>{' '}
                  - {offerFor(chosenPlan).productName}. Nothing is charged now; an
                  admin activates your account once payment is arranged.
                </p>
              )}
              <Field label="Name" value={name} onChange={setName} error={errors.name} autoComplete="name" />
              <Field label="Email" type="email" value={email} onChange={setEmail} error={errors.email} autoComplete="email" />
              <Field
                label="Password"
                type="password"
                value={password}
                onChange={setPassword}
                error={errors.password}
                autoComplete="new-password"
                hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
              />
            </Form>
          )}

          {screen === 'forgot_password' && (
            <Form
              title="Reset your password"
              submit="Send reset link"
              busy={busy}
              onSubmit={() =>
                run(
                  validateSignIn({ email, password: 'unused' }),
                  () =>
                    requestPasswordReset({
                      email,
                      redirectTo: `${window.location.origin}/?auth=reset`,
                    }),
                  // The same confirmation whether or not the address exists.
                  () => {
                    setMessage(RESET_REQUESTED_MESSAGE);
                    go('sent');
                    setMessage(RESET_REQUESTED_MESSAGE);
                  },
                )
              }
              footer={<Link onClick={() => go('sign_in')}>Back to signing in</Link>}
            >
              <Field label="Email" type="email" value={email} onChange={setEmail} error={errors.email} autoComplete="email" />
            </Form>
          )}

          {screen === 'reset_password' && (
            <Form
              title="Choose a new password"
              submit="Save password"
              busy={busy}
              onSubmit={() =>
                run(
                  validateNewPassword(password, confirmation),
                  () => resetPassword({ newPassword: password, token: resetToken ?? '' }),
                  () => {
                    setMessage('Password saved. You can sign in now.');
                    go('sign_in');
                    setMessage('Password saved. You can sign in now.');
                  },
                )
              }
              footer={<Link onClick={() => go('sign_in')}>Back to signing in</Link>}
            >
              <Field label="New password" type="password" value={password} onChange={setPassword} error={errors.password} autoComplete="new-password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} />
              <Field label="Confirm password" type="password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" />
            </Form>
          )}

          {screen === 'sent' && (
            <div>
              <h2 className="text-lg font-black tracking-[-0.03em]">Check your inbox</h2>
              <p className="mt-2 text-[13px] leading-6 text-[#8fa0aa]">
                {RESET_REQUESTED_MESSAGE}
              </p>
              <button
                onClick={() => go('sign_in')}
                className="mt-4 text-[12px] font-bold text-[#b9ff38] hover:underline"
              >
                Back to signing in
              </button>
            </div>
          )}
        </Panel>
      </div>
    </main>
  );
}

function Form({
  title,
  submit,
  busy,
  onSubmit,
  children,
  footer,
}: {
  title: string;
  submit: string;
  busy: boolean;
  onSubmit: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <h2 className="text-lg font-black tracking-[-0.03em]">{title}</h2>
      <div className="mt-4 flex flex-col gap-3">{children}</div>
      <button
        type="submit"
        disabled={busy}
        className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#b9ff38] text-[12px] font-black uppercase tracking-[0.08em] text-[#071019] transition hover:bg-[#cbff6e] disabled:opacity-50"
      >
        {busy && <LoadingMark />}
        {busy ? 'Working' : submit}
      </button>
      {footer && (
        <div className="mt-4 flex flex-wrap justify-between gap-3 border-t border-[#16242d] pt-3">
          {footer}
        </div>
      )}
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  error,
  hint,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  type?: string;
  error?: string;
  hint?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[#5f7280]">
        {label}
      </span>
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1.5 h-11 w-full rounded-xl border bg-[#071019] px-3 text-[14px] font-semibold text-white outline-none focus:border-[#b9ff38] ${
          error ? 'border-[#713c35]' : 'border-[#22333e]'
        }`}
      />
      {error ? (
        <span className="mt-1 block text-[11px] font-semibold text-[#ff9b9b]">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[11px] text-[#4d5f6b]">{hint}</span>
      ) : null}
    </label>
  );
}

function Link({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[12px] font-bold text-[#8fa0aa] transition hover:text-[#b9ff38]"
    >
      {children}
    </button>
  );
}
