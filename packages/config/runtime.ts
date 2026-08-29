/**
 * What the running application knows about its own configuration.
 *
 * The list of variables and the rules about them live in `requirements.mjs`,
 * which the production preflight also imports - so the container's refusal to
 * start and the health endpoint's report can never disagree about what is
 * mandatory.
 */
import { REQUIREMENTS, inspectEnvironment } from './requirements.mjs';

export interface Requirement {
  name: string;
  secret: boolean;
  requiredInProduction: boolean;
  why: string;
}

export interface RuntimeReport {
  production: boolean;
  problems: string[];
  warnings: string[];
  /** Presence only. A value is never read out of here. */
  present: Record<string, boolean>;
}

/**
 * A plain bag of strings, not `NodeJS.ProcessEnv`.
 *
 * The narrower type insists on `NODE_ENV` being present, which makes a test
 * that wants to describe a HALF-configured environment - the entire point of
 * these functions - impossible to write without a cast.
 */
export type Environment = Record<string, string | undefined>;

export function isProduction(env: Environment = process.env): boolean {
  return env.NODE_ENV === 'production';
}

export function requirements(): Requirement[] {
  return REQUIREMENTS as Requirement[];
}

export function inspectRuntime(env: Environment = process.env): RuntimeReport {
  const production = isProduction(env);
  const { problems, warnings } = inspectEnvironment(env, { production });
  const present: Record<string, boolean> = {};
  for (const requirement of REQUIREMENTS as Requirement[]) {
    present[requirement.name] = Boolean(env[requirement.name]?.trim());
  }
  return { production, problems, warnings, present };
}

/**
 * Whether this deployment is safely configured to serve.
 *
 * In production a missing database or auth secret is fatal, because the
 * alternative - falling back to the single-user mode that development uses -
 * would be an unsecured application that looks like a working one.
 */
export function runtimeUsable(env: Environment = process.env): boolean {
  return inspectRuntime(env).problems.length === 0;
}
