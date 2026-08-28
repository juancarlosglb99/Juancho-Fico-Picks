#!/usr/bin/env node
/**
 * Refuses to start a production container that is not safely configured.
 *
 * Run before the server in the container's start command. The failure this
 * exists to prevent is the quiet one: with no DATABASE_URL the application is
 * perfectly capable of serving a draft room with no accounts and no
 * authorisation, which is correct on a laptop and is an unsecured public
 * application on the internet.
 *
 * The rules come from `packages/config/requirements.mjs`, which the running
 * application reads too, so the two cannot drift.
 */
import { inspectEnvironment } from '../packages/config/requirements.mjs';

const production = process.env.NODE_ENV === 'production';
const { problems, warnings } = inspectEnvironment(process.env, { production });

for (const warning of warnings) console.warn(`  warning: ${warning}`);

if (problems.length > 0) {
  console.error(
    `\nRefusing to start: ${problems.length} configuration problem${problems.length === 1 ? '' : 's'}.\n`,
  );
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nSet these in the App Platform environment and redeploy.\n');
  process.exit(1);
}

console.log(
  production
    ? '  configuration ok: accounts and authentication are configured'
    : '  configuration ok (development): accounts are optional',
);
