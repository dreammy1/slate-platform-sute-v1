import { Card, CardDescription, CardHeader, CardTitle } from '@slate/ui';

import { requireActor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** The admin overview (SLATE-302): the modules, each permission-gated server-side. */
const MODULES = [
  {
    href: '/tenants',
    title: 'Tenant management',
    description: 'List reachable tenants, create one and inspect its members.',
  },
  {
    href: '/users',
    title: 'User & role administration',
    description: 'Review tenant members and assign roles, guarded against privilege escalation.',
  },
  {
    href: '/features',
    title: 'Feature flag overrides',
    description: 'See every flag’s effective value and source, and set a per-tenant override.',
  },
  {
    href: '/health',
    title: 'System health',
    description: 'Liveness and readiness probes, projected to a sanitized status.',
  },
] as const;

export default async function OverviewPage() {
  await requireActor();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Administer the active tenant. Every write is authorized server-side and leaves one
          attributable audit row.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        {MODULES.map((module) => (
          <Card key={module.href}>
            <CardHeader>
              <CardTitle as="h2">
                <a className="underline" href={module.href}>
                  {module.title}
                </a>
              </CardTitle>
              <CardDescription>{module.description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </section>
    </div>
  );
}
