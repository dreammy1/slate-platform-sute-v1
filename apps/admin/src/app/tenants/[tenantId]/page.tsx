import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@slate/ui';

import { adminServices } from '@/server/admin/runtime';
import { TenantNotFoundError, type TenantDetail } from '@/server/admin/tenants';
import { requireActor } from '@/server/session';

export const dynamic = 'force-dynamic';

interface TenantDetailPageProps {
  readonly params: Promise<{ readonly tenantId: string }>;
}

/** Tenant detail: the reachable tenant and its members (ADR 010 §2). */
export default async function TenantDetailPage({ params }: TenantDetailPageProps) {
  const actor = await requireActor();
  const { tenantId } = await params;
  const { tenants } = await adminServices();

  let detail: TenantDetail;
  try {
    detail = await tenants.getTenantDetail(actor, tenantId);
  } catch (error) {
    if (error instanceof TenantNotFoundError) {
      return (
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold text-foreground">Tenant not found</h1>
          <p className="text-sm text-muted-foreground">
            This tenant is not one of your memberships, so it is hidden rather than re-scoped.
          </p>
          <Button asChild variant="secondary" size="sm">
            <a href="/tenants">Back to tenants</a>
          </Button>
        </div>
      );
    }
    throw error;
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">{detail.tenant.name}</h1>
        <p className="text-sm text-muted-foreground">
          {`${detail.tenant.slug} · ${detail.tenant.organizationName} · ${detail.tenant.memberCount} member(s)`}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle as="h2">Members</CardTitle>
          <CardDescription>
            Users with a membership in this tenant and the role they currently hold.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Members of this tenant</caption>
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="py-1">
                  Name
                </th>
                <th scope="col" className="py-1">
                  Email
                </th>
                <th scope="col" className="py-1">
                  Role
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.members.map((member) => (
                <tr key={member.userId} className="border-t border-border">
                  <td className="py-1">{member.name}</td>
                  <td className="py-1">{member.email}</td>
                  <td className="py-1">{member.roleName ?? 'No role'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-sm">
        <a className="underline" href="/tenants">
          Back to tenants
        </a>
      </p>
    </div>
  );
}
