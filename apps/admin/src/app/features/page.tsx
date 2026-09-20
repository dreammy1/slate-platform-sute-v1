import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@slate/ui';

import { adminServices } from '@/server/admin/runtime';
import { requireActor } from '@/server/session';

import { setFeatureFlagAction } from '../actions';
import { outcomeBanner, type SearchParams } from '../search-params';

export const dynamic = 'force-dynamic';

interface FeaturesPageProps {
  readonly searchParams: Promise<SearchParams>;
}

const SOURCE_LABEL = {
  override: 'Tenant override',
  'registry-default': 'Registry default',
  undeclared: 'Undeclared',
} as const;

/** Feature-flag override control panel (ADR 010 §4). */
export default async function FeaturesPage({ searchParams }: FeaturesPageProps) {
  const actor = await requireActor();
  const params = await searchParams;
  const { flags } = await adminServices();
  const entries = await flags.panel(actor);
  const message = outcomeBanner(params, 'saved', 'Feature flag saved.');

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Feature flags</h1>
        <p className="text-sm text-muted-foreground">
          Effective value = tenant override → registry default → off. Each change is confined to the
          active tenant and audited.
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
          <CardTitle as="h2">Declared flags</CardTitle>
          <CardDescription>{entries.length} flag(s) declared in the registry.</CardDescription>
        </CardHeader>
        <CardContent>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Feature flags and their effective tenant value</caption>
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="py-1">
                  Flag
                </th>
                <th scope="col" className="py-1">
                  Effective
                </th>
                <th scope="col" className="py-1">
                  Source
                </th>
                <th scope="col" className="py-1">
                  Override
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.key} className="border-t border-border align-top">
                  <td className="py-2 font-medium text-foreground">{entry.key}</td>
                  <td className="py-2">{entry.enabled ? 'On' : 'Off'}</td>
                  <td className="py-2 text-muted-foreground">{SOURCE_LABEL[entry.source]}</td>
                  <td className="py-2">
                    <form action={setFeatureFlagAction} className="flex items-center gap-2">
                      <input type="hidden" name="key" value={entry.key} />
                      <label htmlFor={`flag-${entry.key}`} className="sr-only">
                        {`Override for ${entry.key}`}
                      </label>
                      <select
                        id={`flag-${entry.key}`}
                        name="enabled"
                        defaultValue={
                          entry.source === 'override' ? String(entry.enabled) : 'default'
                        }
                        className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                      >
                        <option value="true">On</option>
                        <option value="false">Off</option>
                        <option value="default">Default</option>
                      </select>
                      <Button type="submit" variant="secondary" size="sm">
                        Save
                      </Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
