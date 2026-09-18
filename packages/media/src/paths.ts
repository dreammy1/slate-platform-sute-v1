export function getTenantPath(tenantId: string, category: string, fileName: string): string {
  return `storage/${tenantId}/${category}/${fileName}`;
}

export function assertTenantBound(tenantId: string, path: string): void {
  if (!path.startsWith(`storage/${tenantId}/`)) {
    throw new Error(`Tenant isolation violation: path ${path} is not bound to tenant ${tenantId}`);
  }
}
