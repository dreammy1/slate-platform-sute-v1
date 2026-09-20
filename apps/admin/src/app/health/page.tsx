import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@slate/ui';

import { collectHealthSnapshot } from '@/server/admin/health';
import { adminServices } from '@/server/admin/runtime';
import { requireActor } from '@/server/session';

export const dynamic = 'force-dynamic';

const STATE_LABEL = { healthy: 'Healthy', unavailable: 'Unavailable' } as const;

/**
 * System health dashboard (ADR 010 §5): the live and ready probes projected to
 * a sanitized status. The page shows a status word and the probe's HTTP code,
 * never a stack trace or configuration.
 */
export default async function HealthPage() {
  await requireActor();
  const { db } = await adminServices();
  const snapshot = await collectHealthSnapshot(db);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">System health</h1>
        <p className="text-sm text-muted-foreground">
          Read-only. Liveness touches nothing; readiness checks the database. A failure reduces to a
          status word — internals stay in the logs.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle as="h2">Probes</CardTitle>
          <CardDescription>
            {`Overall ${STATE_LABEL[snapshot.status]} · checked ${snapshot.checkedAt}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Platform health probes</caption>
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="py-1">
                  Probe
                </th>
                <th scope="col" className="py-1">
                  State
                </th>
                <th scope="col" className="py-1">
                  HTTP
                </th>
              </tr>
            </thead>
            <tbody>
              {snapshot.probes.map((probe) => (
                <tr key={probe.id} className="border-t border-border">
                  <td className="py-1">{probe.label}</td>
                  <td className="py-1">{STATE_LABEL[probe.state]}</td>
                  <td className="py-1">{probe.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">
            <a className="underline" href="/health">
              Re-check
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
