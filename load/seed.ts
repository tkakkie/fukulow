import { check, fail } from 'k6';
import { randomBytes } from 'k6/crypto';
import http, { type Params, type Response } from 'k6/http';
import type { Channel, CreateChannelRequest, NativeSessionResponse, SetupRequest, SignInRequest } from '../web/src/api-schema.d.ts';
import { positiveInteger } from './delivery.ts';
import { revokeSessions } from './sessions.ts';
import { legacyOrganization, organizationPath, signInPath } from './compat.ts';
export const baseUrl = (__ENV.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const requestTimeout = positiveInteger(__ENV.REQUEST_TIMEOUT_SECONDS, 45);
export type Setup = { token: string; tokens: string[]; channelIds: string[]; organizationId: string };
type SeedConfig = { channels: number; subscribers: number; socketsPerSession: number; visibility: Channel['visibility']; legacy: boolean };

export function params(operation: string, token?: string): Params {
  return { timeout: `${requestTimeout}s`, redirects: 0, tags: { name: operation, operation },
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
}

export function requireStatus(response: Response, status: number, operation: string): void {
  if (!check(response, { [operation]: (r) => r.status === status })) {
    // Never print response bodies: sign-in returns the bearer credential.
    fail(`${operation} returned ${response.status}, expected ${status}`);
  }
}

export function seed(config: SeedConfig): Setup {
  const { channels, subscribers, socketsPerSession, visibility, legacy } = config;
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
  const response = http.post(`${baseUrl}${signInPath(legacy)}`, JSON.stringify(body), params('sign_in'));
  requireStatus(response, 200, 'sign_in');
  const { token, identity } = response.json() as NativeSessionResponse;
  const organizationId = legacy ? legacyOrganization(identity) : (__ENV.LOAD_ORGANIZATION_ID || identity.organizations[0]?.organization_id);
  if (!organizationId || (!legacy && !identity.organizations.some((organization) => organization.organization_id === organizationId))) fail('LOAD_ORGANIZATION_ID must name an active Organization membership');
  const tokens = [token];
  try {
    for (let i = 1; i < Math.ceil(channels * subscribers / socketsPerSession); i++) {
      const session = http.post(`${baseUrl}${signInPath(legacy)}`, JSON.stringify(body), params('sign_in'));
      requireStatus(session, 200, 'sign_in');
      tokens.push((session.json() as NativeSessionResponse).token);
    }
    const channelIds = Array.from({ length: channels }, (_, index) => {
      const body: CreateChannelRequest = { name: `load-${Date.now()}-${index}`, visibility };
      const response = http.post(`${baseUrl}${organizationPath(organizationId, legacy)}/channels`, JSON.stringify(body), params('create_channel', token));
      requireStatus(response, 201, 'create_channel');
      return (response.json() as Channel).id;
    });
    return { token, tokens, channelIds, organizationId };
  } catch (error) {
    // k6 skips teardown when setup fails; retain the provisioning error if sign-out also fails.
    try {
      revoke({ token, tokens, channelIds: [], organizationId });
    } catch {
      console.error('Failed to revoke session after setup failure');
    }
    throw error;
  }
}

export function uuid(): string {
  const bytes = new Uint8Array(randomBytes(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function revoke(data: Setup): void {
  revokeSessions(data?.tokens ?? [], (token) => {
    requireStatus(http.del(`${baseUrl}/api/v1/session`, null, params('sign_out', token)), 204, 'sign_out');
  });
}

