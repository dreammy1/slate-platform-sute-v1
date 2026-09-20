import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@slate/ui';

import { adminServices } from '@/server/admin/runtime';
import { requireActor } from '@/server/session';

import { createTenantAction } from '../actions';
import { outcomeBanner, type SearchParams } from '../search-params';

export const dynamic = 'force-dynamic';

interface TenantsPageProps {
  readonly searchParams: Promise<SearchParams>;
}

/** Tenant management: the reachable tenants plus a create form (ADR 010 §2). */
export default async function TenantsPage({ searchParams }: TenantsPageProps) {
  const actor = await requireActor();
  const params = await searchParams;
  const { tenants } = await adminServices();
  const rows = await tenants.listTenants(actor);
  const message = outcomeBanner(params, 'created', 'Tenant created.');

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Tenants</h1>
        <p className="text-sm text-muted-foreground">
          Only tenants your account belongs to are listed. Another tenant is refused, never
          re-scoped.
        </p>
      </header>

      {message === undefined ? null : (
        <p
          role="status"
          className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
        >
          {message}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle as="h2">Tenants you can administer</CardTitle>
          <CardDescription>{rows.length} reachable tenant(s).</CardDescription>
        </CardHeader>
        <CardContent>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Tenants the acting user is a member of</caption>
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="py-1">
                  Name
                </th>
                <th scope="col" className="py-1">
                  Slug
                </th>
                <th scope="col" className="py-1">
                  Organization
                </th>
                <th scope="col" className="py-1">
                  Members
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((tenant) => (
                <tr key={tenant.id} className="border-t border-border">
                  <td className="py-1">
                    <a className="underline" href={`/tenants/${tenant.id}`}>
                      {tenant.name}
                    </a>
                  </td>
                  <td className="py-1">{tenant.slug}</td>
                  <td className="py-1">{tenant.organizationName}</td>
                  <td className="py-1">{tenant.memberCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">Create a tenant</CardTitle>
          <CardDescription>
            Created inside your organization. The write is authorized server-side and leaves one
            attributable audit row.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            action={createTenantAction}
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <Input id="tenant-name" name="name" label="Name" required maxLength={120} />
            <Input
              id="tenant-slug"
              name="slug"
              label="Slug"
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              hint="Lowercase words separated by single hyphens."
            />
            <Button type="submit" variant="primary">
              Create tenant
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
