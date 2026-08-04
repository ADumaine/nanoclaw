/**
 * Egress lockdown — force ALL agent traffic through the OneCLI gateway.
 * Agents run on a Docker `--internal` network (no internet route) with the
 * gateway attached as host.docker.internal, so the injected proxy is the only
 * reachable hop. Non-root, no NET_ADMIN — the agent can't undo it.
 *
 * Fail-fast: when the flag is on but the network/gateway can't be set up, throw
 * rather than silently spawn an agent with open egress.
 */
import { execFileSync } from 'child_process';

import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

// .env is deliberately never loaded into process.env (see env.ts) — these
// must be read fresh via readEnvFile, not process.env, or they silently
// always read as unset regardless of what's in .env. (Previously all three
// read process.env directly, so NANOCLAW_EGRESS_LOCKDOWN=true in .env had
// no effect — same class of bug as the SKILLSCRIPT_RPC_URL and
// CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS fixes earlier.)

/** Locked-down, no-internet network agents are placed on. */
export function egressNetwork(): string {
  return readEnvFile(['NANOCLAW_EGRESS_NETWORK'])['NANOCLAW_EGRESS_NETWORK'] || 'nanoclaw-egress';
}
/** The OneCLI gateway container attached as the only egress hop. */
function onecliGatewayContainer(): string {
  return readEnvFile(['ONECLI_GATEWAY_CONTAINER'])['ONECLI_GATEWAY_CONTAINER'] || 'onecli';
}
/** Off by default; set NANOCLAW_EGRESS_LOCKDOWN=true to opt in. */
function egressLockdownEnabled(): boolean {
  return readEnvFile(['NANOCLAW_EGRESS_LOCKDOWN'])['NANOCLAW_EGRESS_LOCKDOWN'] === 'true';
}

/** Raised when lockdown is requested but can't be established. */
export class EgressLockdownError extends Error {
  constructor(reason: string) {
    super(
      `Egress lockdown is on (NANOCLAW_EGRESS_LOCKDOWN=true) but ${reason}. ` +
        `Refusing to spawn with open egress. Start the OneCLI gateway container ` +
        `"${onecliGatewayContainer()}", or set NANOCLAW_EGRESS_LOCKDOWN=false to opt out.`,
    );
    this.name = 'EgressLockdownError';
  }
}

function dockerOk(args: string[]): boolean {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** Is the OneCLI gateway currently attached to the egress network? */
function gatewayAttached(network: string, gateway: string): boolean {
  try {
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['network', 'inspect', network, '--format', '{{range .Containers}}{{.Name}} {{end}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 15000 },
    );
    return out.split(/\s+/).includes(gateway);
  } catch {
    return false;
  }
}

/**
 * Ensure the egress network exists with the OneCLI gateway attached (aliased
 * host.docker.internal). Idempotent + self-healing. Returns false when lockdown
 * is disabled (caller uses the host gateway), true when it's active. Throws
 * EgressLockdownError when enabled but unestablishable — fail fast rather than
 * spawn an agent with open egress.
 */
export function ensureEgressNetwork(): boolean {
  if (!egressLockdownEnabled()) return false;

  const network = egressNetwork();
  const gateway = onecliGatewayContainer();

  if (!dockerOk(['network', 'inspect', network]) && !dockerOk(['network', 'create', '--internal', network])) {
    throw new EgressLockdownError(`the "${network}" internal network could not be created`);
  }

  if (gatewayAttached(network, gateway)) return true;

  if (
    dockerOk(['network', 'connect', '--alias', 'host.docker.internal', network, gateway]) &&
    gatewayAttached(network, gateway)
  ) {
    log.info('Egress lockdown: OneCLI gateway attached', { network, gateway });
    return true;
  }

  throw new EgressLockdownError(`the OneCLI gateway "${gateway}" could not be attached to "${network}"`);
}

/** CLI args placing a container on the locked-down egress network. */
export function egressNetworkArgs(): string[] {
  return ['--network', egressNetwork()];
}
