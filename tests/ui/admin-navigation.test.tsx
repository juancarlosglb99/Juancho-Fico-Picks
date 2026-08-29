/**
 * Whether the header offers the admin page, and to whom.
 *
 * The admin dashboard was reachable only by typing the URL. It is now the plan
 * badge, which already said ADMIN to exactly the right people. The risk that
 * comes with that is not a security one - `/admin` fetches from routes that
 * answer 404 to anybody the entitlement table does not call an admin - it is
 * that the header and the API disagree, and somebody is shown a door that does
 * not open.
 *
 * So these tests start from an entitlement ROW, run it through the same
 * `resolveAccess` + `isAdmin` the server's `requireAdmin` uses, and assert on
 * the rendered markup. A change that made the two disagree would have to break
 * one of these.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreDraft } from '../../app/components/pre-draft';
import {
  isAdmin,
  resolveAccess,
  type Entitlement,
} from '../../packages/accounts/entitlements';

const NOW = new Date('2026-09-01T12:00:00.000Z');

function entitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    plan: 'admin',
    status: 'active',
    validFrom: '2026-08-01T00:00:00.000Z',
    validUntil: null,
    ...overrides,
  };
}

/**
 * The header as a signed-in user with this entitlement row actually sees it.
 *
 * The admin decision is taken exactly where `app/dashboard.tsx` takes it, from
 * the access state and plan the server's account summary reports.
 */
function header(row: Entitlement | null): string {
  const access = resolveAccess(row, NOW);
  return renderToStaticMarkup(
    <PreDraft
      step="connect"
      username=""
      onUsernameChange={() => {}}
      onConnect={() => {}}
      onBack={() => {}}
      busy={false}
      error={null}
      displayName={null}
      season={null}
      leagues={[]}
      onSelectLeague={() => {}}
      drafts={[]}
      discovered={[]}
      discoveryBusy={false}
      onSelectDraft={() => {}}
      onBrowseLeagues={() => {}}
      userId={null}
      attachValue=""
      onAttachValueChange={() => {}}
      onAttach={() => {}}
      attachError={null}
      readiness={null}
      readinessBusy={false}
      onEnter={() => {}}
      onDetach={() => {}}
      account={{
        email: 'jguerreroleon14@gmail.com',
        plan: access.plan,
        creditsRemaining: null,
        isAdmin: isAdmin(access.state, access.plan),
        onSignOut: () => {},
      }}
    />,
  );
}

/** The badge, whichever element it turned out to be. */
function badge(html: string): string {
  const match = html.match(/<(a|span)[^>]*rounded-full border[^>]*>[^<]*<\/\1>/);
  return match ? match[0] : '';
}

describe('the admin page is reachable from the header', () => {
  it('gives an admin a link to /admin', () => {
    const html = header(entitlement());
    expect(badge(html)).toContain('href="/admin"');
    expect(badge(html)).toMatch(/^<a /);
  });

  it('labels the link, so it is not an unexplained badge', () => {
    // The visible text is the plan - ADMIN, uppercased by the badge's own
    // styling - and the title says where it goes.
    expect(badge(header(entitlement()))).toContain('admin');
    expect(badge(header(entitlement()))).toContain('title="Open the admin dashboard"');
  });

  it('is keyboard reachable and operable without a handler', () => {
    const element = badge(header(entitlement()));
    // A real anchor WITH an href: in the tab order, and activated by Enter,
    // both for free. Neither is true of a div with an onClick, and a positive
    // tabindex would be a bug rather than a fix.
    expect(element).toMatch(/^<a [^>]*href="\/admin"/);
    expect(element).not.toContain('tabindex');
    expect(element).not.toContain('aria-hidden');
  });

  it('shows a focus ring that does not depend on hover', () => {
    const element = badge(header(entitlement()));
    // Hover alone would leave a keyboard user with no idea where they are.
    expect(element).toContain('hover:text-[#b9ff38]');
    expect(element).toContain('focus-visible:ring-2');
    expect(element).toContain('focus-visible:text-[#b9ff38]');
  });

  it('keeps the badge looking like the badge', () => {
    // Same shape and same resting colours as every other plan. Becoming a link
    // changed what it does, not how the header reads.
    const admin = badge(header(entitlement()));
    const customer = badge(header(entitlement({ plan: 'pro' })));
    for (const shape of [
      'rounded-full',
      'border',
      'px-2',
      'py-0.5',
      'uppercase',
      'tracking-[0.08em]',
      'border-[#25373f]',
      'text-[#8fa0aa]',
    ]) {
      expect(admin).toContain(shape);
      expect(customer).toContain(shape);
    }
  });
});

describe('everybody else is offered nothing', () => {
  /*
   * Every way of not being an admin, including the ones that look like being
   * one. An `admin` row that is revoked, not yet valid, or expired resolves to
   * a basic plan - and if that ever stopped being true, the first assertion
   * here would fail rather than a stranger finding a link.
   */
  const notAdmins: [string, Entitlement | null][] = [
    ['a basic customer', entitlement({ plan: 'basic' })],
    ['a pro customer', entitlement({ plan: 'pro' })],
    ['nobody who has been activated yet', null],
    ['a revoked admin', entitlement({ status: 'revoked' })],
    ['an expired admin', entitlement({ status: 'expired' })],
    ['an admin whose grant has not started', entitlement({ validFrom: '2026-12-01T00:00:00.000Z' })],
    ['an admin whose grant has run out', entitlement({ validUntil: '2026-08-15T00:00:00.000Z' })],
  ];

  for (const [who, row] of notAdmins) {
    it(`shows ${who} no way to the admin page`, () => {
      const html = header(row);
      expect(html).not.toContain('/admin');
      expect(badge(html)).toMatch(/^<span /);
      // The badge is still there. They are told their plan, just not offered
      // a page that would refuse them.
      expect(badge(html)).not.toBe('');
    });
  }

  it('never calls a non-admin an admin', () => {
    for (const [, row] of notAdmins) {
      const access = resolveAccess(row, NOW);
      expect(isAdmin(access.state, access.plan)).toBe(false);
    }
  });
});

describe('the predicate the server guards with', () => {
  /*
   * `requireAdmin` is `isAdmin(access.state, access.plan)` over a row read from
   * the database. It cannot be called here without Postgres, so what is pinned
   * instead is the rule itself: active AND admin, and nothing else.
   */
  it('wants both an active account and the admin plan', () => {
    expect(isAdmin('active', 'admin')).toBe(true);
    expect(isAdmin('pending', 'admin')).toBe(false);
    expect(isAdmin('revoked', 'admin')).toBe(false);
    expect(isAdmin('active', 'pro')).toBe(false);
    expect(isAdmin('active', 'basic')).toBe(false);
  });
});
