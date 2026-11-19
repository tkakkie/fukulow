import { check, fail } from 'k6';
import { randomBytes } from 'k6/crypto';
import http, { type Params, type Response } from 'k6/http';
import type { AcceptInviteRequest, Channel, CreateChannelRequest, CreateInviteRequest, InviteResponse, NativeSessionResponse, SetupRequest, SignInRequest } from '../web/src/api-schema.d.ts';
import { positiveInteger } from './delivery.ts';
import { revokeSessions } from './sessions.ts';
import { legacyOrganization, organizationPath, signInPath } from './compat.ts';
import { sessionLayout } from './session-layout.ts';
export const baseUrl = (__ENV.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const requestTimeout = positiveInteger(__ENV.REQUEST_TIMEOUT_SECONDS, 45);
export type Setup = { token: string; tokens: string[]; publisherTokens: string[]; channelIds: string[]; organizationId: string };
type SeedConfig = { channels: number; subscribers: number; socketsPerSession: number; visibility: Channel['visibility']; legacy: boolean;
  /** 0 keeps every socket on the Owner's Account (pre-#196 baselines). */
  socketsPerAccount?: number; publishMembers?: number };

export function params(operation: string, token?: string): Params {
  return { timeout: `${requestTimeout}s`, redirects: 0, tags: { name: operation, operation },
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
}

let transportRecorded = false;
export function requireTransport(response: Response): void {
  if (!__ENV.LOAD_PROXY) return;
  if (response.proto !== 'HTTP/1.1' || response.tls_version !== 'tls1.3' || response.tls_cipher_suite !== 'TLS_AES_128_GCM_SHA256') {
    fail('Proxy measurement requires HTTP/1.1, TLS 1.3 and TLS_AES_128_GCM_SHA256 on actual k6 responses');
  }
  if (!transportRecorded) {
    console.log('LOAD_TLS ' + JSON.stringify({ protocol: response.tls_version, cipher: response.tls_cipher_suite, http: response.proto }));
    transportRecorded = true;
  }
}

export function requireStatus(response: Response, status: number, operation: string): void {
  requireTransport(response);
  if (!check(response, { [operation]: (r) => r.status === status })) {
    // Never print response bodies: sign-in returns the bearer credential.
    fail(`${operation} returned ${response.status}, expected ${status}`);
  }
}

export function seed(config: SeedConfig): Setup {
  const { channels, subscribers, socketsPerSession, visibility, legacy } = config;
  const { socketsPerAccount = 0, publishMembers = 1 } = config;
  if (socketsPerAccount && (legacy || socketsPerSession !== socketsPerAccount || visibility !== 'public')) {
    fail('SOCKETS_PER_ACCOUNT needs the current API, public Channels and SOCKETS_PER_SESSION equal to it');
  }
  if (publishMembers > 1 && (legacy || visibility !== 'public')) {
    fail('PUBLISH_MEMBERS greater than 1 needs the current API and public Channels');
  }
  requireStatus(http.get(`${baseUrl}/api/v1/health`, params('health')), 200, 'health');
  const email = __ENV.LOAD_EMAIL;
  const password = __ENV.LOAD_PASSWORD;
  if (!email || !password) fail('Set LOAD_EMAIL and LOAD_PASSWORD for a disposable test Organization');
  if (__ENV.LOAD_BOOTSTRAP === '1') {
    const body: SetupRequest = { email, password, name: 'Load Owner',
      organization_name: 'Load test', setup_token: __ENV.LOAD_SETUP_TOKEN };
    requireStatus(http.post(`${baseUrl}/api/v1/setup`, JSON.stringify(body), params('setup')), 201, 'setup');
  }
  const body: SignInRequest = { email, password };
  const tokens: string[] = [];
  try {
    const response = http.post(`${baseUrl}${signInPath(legacy)}`, JSON.stringify(body), params('sign_in'));
    const signedIn = response.status === 200 ? response.json() as NativeSessionResponse : undefined;
    if (signedIn) tokens.push(signedIn.token);
    requireStatus(response, 200, 'sign_in');
    const { token, identity } = signedIn!;
    const layout = sessionLayout(channels * subscribers, socketsPerSession, socketsPerAccount, publishMembers);
    // Each multi-Member run adds Members; use a fresh Organization (load/measurements-archive.md, #604).
    const organizationId = legacy ? legacyOrganization(identity) : (__ENV.LOAD_ORGANIZATION_ID || identity.organizations[0]?.organization_id);
    if (!organizationId || (!legacy && !identity.organizations.some((organization) => organization.organization_id === organizationId))) fail('LOAD_ORGANIZATION_ID must name an active Organization membership');
    for (let i = 1; i < layout.ownerSessions; i++) {
      const session = http.post(`${baseUrl}${signInPath(legacy)}`, JSON.stringify(body), params('sign_in'));
      const signedIn = session.status === 200 ? session.json() as NativeSessionResponse : undefined;
      if (signedIn) tokens.push(signedIn.token);
      requireStatus(session, 200, 'sign_in');
    }
    if (layout.accounts > 1) {
      const run = uuid().slice(0, 8);
      for (let i = 1; i < layout.accounts; i++) member(organizationId, token, run, i, tokens);
    }
    const publisherTokens = Array.from({ length: publishMembers }, (_, i) => tokens[layout.publisherTokenIndex(i)]);
    const channelIds = Array.from({ length: channels }, (_, index) => {
      const body: CreateChannelRequest = { name: `load-${Date.now()}-${index}`, visibility };
      const response = http.post(`${baseUrl}${organizationPath(organizationId, legacy)}/channels`, JSON.stringify(body), params('create_channel', token));
      requireStatus(response, 201, 'create_channel');
      return (response.json() as Channel).id;
    });
    // Prove before measuring that every Account may read each Channel its sockets subscribe to.
    if (socketsPerAccount) tokens.slice(0, layout.socketAccounts).forEach((accountToken, account) => {
      const first = account * socketsPerAccount;
      const last = Math.min(first + socketsPerAccount, channels * subscribers) - 1;
      for (let channel = Math.floor(first / subscribers); channel <= Math.floor(last / subscribers); channel++) {
        requireStatus(http.get(`${baseUrl}${organizationPath(organizationId, false)}/channels/${channelIds[channel]}/messages?limit=1`,
          params('channel_access', accountToken)), 200, 'channel_access');
      }
    });
    return { token, tokens, publisherTokens, channelIds, organizationId };
  } catch (error) {
    // k6 skips teardown when setup fails; retain the provisioning error if sign-out also fails.
    try {
      revoke({ tokens });
    } catch {
      console.error('Failed to revoke session after setup failure');
    }
    throw error;
  }
}

// A separate Account (not another Account Session) in the Organization, signed in once.
function member(organizationId: string, ownerToken: string, run: string, index: number, tokens: string[]): void {
  const email = `load-${run}-${index}@example.invalid`;
  const password = uuid();
  const path = `${baseUrl}${organizationPath(organizationId, false)}`;
  const invite: CreateInviteRequest = { email, role: 'member' };
  const response = http.post(`${path}/invites`, JSON.stringify(invite), params('invite', ownerToken));
  requireStatus(response, 201, 'invite');
  const accept: AcceptInviteRequest = { email, password, name: `Load Member ${index}`, token: (response.json() as InviteResponse).token };
  requireStatus(http.post(`${path}/invites/accept`, JSON.stringify(accept), params('accept_invite')), 200, 'accept_invite');
  const signIn: SignInRequest = { email, password };
  const session = http.post(`${baseUrl}${signInPath(false)}`, JSON.stringify(signIn), params('sign_in'));
  // Register the Session before checking transport or Organization membership.
  const signedIn = session.status === 200 ? session.json() as NativeSessionResponse : undefined;
  if (signedIn) tokens.push(signedIn.token);
  requireStatus(session, 200, 'sign_in');
  if (!signedIn?.identity.organizations.some(organization => organization.organization_id === organizationId)) fail('Invited Account lacks the Organization membership');
}

export function uuid(): string {
  const bytes = new Uint8Array(randomBytes(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function revoke(data: Pick<Setup, 'tokens'>): void {
  revokeSessions(data?.tokens ?? [], (token) => {
    requireStatus(http.del(`${baseUrl}/api/v1/session`, null, params('sign_out', token)), 204, 'sign_out');
  });
}

