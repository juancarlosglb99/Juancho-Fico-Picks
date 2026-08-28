'use client';

/**
 * Registered, and waiting for somebody to say yes.
 *
 * The private beta's access control is a person rather than a payment: creating
 * an account gets you an account, and an admin activates it. This is the screen
 * in between, and its whole job is to make that state legible - a sign-in that
 * appears to work and then shows an empty product is far worse than one that
 * says plainly what is happening.
 */
import { Brand, Panel } from './primitives';

export function PendingScreen({
  email,
  revoked,
  onSignOut,
}: {
  email: string | null;
  /** Access taken away deliberately reads differently from never granted. */
  revoked: boolean;
  onSignOut: () => void;
}) {
  return (
    <main className="min-h-screen bg-[#071019] text-[#f7f8f2]">
      <header className="border-b border-[#1c2b35] px-5 py-4">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4">
          <Brand />
          <button
            onClick={onSignOut}
            className="text-[11px] font-bold text-[#5f7280] transition hover:text-[#ff9a80]"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-5 py-16">
        <Panel className="p-6">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#e0a13c]">
            {revoked ? 'Access ended' : 'Waiting for activation'}
          </p>
          <h1 className="mt-3 text-2xl font-black tracking-[-0.03em]">
            {revoked
              ? 'This account no longer has access.'
              : 'Your account is ready, but not switched on yet.'}
          </h1>
          <p className="mt-3 max-w-xl text-[14px] leading-7 text-[#a3b1ba]">
            {revoked
              ? 'If you think that is a mistake, reply to whoever invited you.'
              : 'Juancho-Fico Picks is in a private beta, so accounts are activated by hand. Yours exists and is safe - somebody just has to let you in.'}
          </p>
          {email && (
            <p className="mt-4 text-[12px] font-bold text-[#5f7280]">
              Signed in as {email}
            </p>
          )}
        </Panel>
      </div>
    </main>
  );
}
