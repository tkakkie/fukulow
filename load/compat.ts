// Only the pre-#146 measurement baseline uses the old routes/identity shape.
export function signInPath(legacy: boolean): string {
  return legacy ? '/api/v1/session' : '/api/v1/native/session';
}
export function organizationPath(organization: string, legacy: boolean): string {
  return legacy ? '/api/v1' : `/api/v1/orgs/${organization}`;
}
export function legacyOrganization(identity: unknown): string {
  if (typeof identity !== 'object' || identity === null || !('organization' in identity) ||
      typeof identity.organization !== 'object' || identity.organization === null ||
      !('organization_id' in identity.organization) || typeof identity.organization.organization_id !== 'string') throw new Error('Invalid legacy identity');
  return identity.organization.organization_id;
}
