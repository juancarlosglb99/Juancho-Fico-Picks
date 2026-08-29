/**
 * Where verification and reset messages go.
 *
 * No provider is wired yet, and that is deliberate: the flows are the part that
 * has to be right, and they are identical whether the message leaves by SMTP,
 * Postmark or a file. So this is the seam. Configure a sender later and nothing
 * above it changes.
 *
 * The development sender writes the link to the server log rather than
 * pretending to send. A silent no-op would let a broken flow look healthy for
 * weeks, which is the failure this shape exists to prevent.
 */

export interface OutboundEmail {
  to: string;
  subject: string;
  /** Plain text. The templates are two lines; HTML can wait for a designer. */
  body: string;
  /** The action link, called out so a log line is usable without parsing. */
  link?: string;
}

export interface MailSender {
  readonly id: string;
  send(message: OutboundEmail): Promise<void>;
}

/** Prints the link. Usable, obvious, and impossible to mistake for production. */
export const consoleMailSender: MailSender = {
  id: 'console',
  async send(message) {
    console.info(
      `[email:${message.subject}] to=${message.to}${message.link ? ` link=${message.link}` : ''}`,
    );
  },
};

/**
 * Refuses rather than dropping the message.
 *
 * Used when the deployment has declared that email must work - a lost
 * verification link is a user who cannot sign in and never finds out why.
 */
export const refusingMailSender: MailSender = {
  id: 'unconfigured',
  async send() {
    throw new Error(
      'No email provider is configured. Set EMAIL_PROVIDER credentials, or unset AUTH_REQUIRE_EMAIL_VERIFICATION.',
    );
  },
};

export function resolveMailSender(): MailSender {
  /*
   * There is exactly one sender today. The branch exists so that adding a real
   * one is a change here and nowhere else.
   */
  return process.env.AUTH_REQUIRE_EMAIL_VERIFICATION === 'true' &&
    process.env.NODE_ENV === 'production'
    ? refusingMailSender
    : consoleMailSender;
}

export function verificationEmail(to: string, link: string): OutboundEmail {
  return {
    to,
    subject: 'Confirm your email',
    link,
    body: `Confirm your email address to finish setting up Juancho-Fico Picks:\n\n${link}\n`,
  };
}

export function resetPasswordEmail(to: string, link: string): OutboundEmail {
  return {
    to,
    subject: 'Reset your password',
    link,
    body: `Use this link to choose a new password. It expires in an hour.\n\n${link}\n\nIf you did not ask for this, you can ignore it.\n`,
  };
}
