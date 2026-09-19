import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@slate/ui';

/**
 * The scaffolded admin shell (SLATE-300). It renders from the design system only
 * — the real, session-resolved tenant data shell is SLATE-301, which owns the
 * authentication surfaces this page deliberately does not fake.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">Slate Admin</h1>
        <span className="text-sm text-muted-foreground">workspace scaffold</span>
      </header>

      <Card>
        <CardHeader>
          <CardTitle as="h2">Phase 3 scaffolding is in place</CardTitle>
          <CardDescription>
            The shared design system, the typed API client and the versioned API mount are wired.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          The authenticated tenant-data shell — sidebar, topbar, settings and feature-flag screens —
          lands with SLATE-301 and SLATE-302.
        </CardContent>
      </Card>

      <section className="flex flex-wrap gap-3">
        <Button variant="primary">Primary action</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
      </section>
    </main>
  );
}
