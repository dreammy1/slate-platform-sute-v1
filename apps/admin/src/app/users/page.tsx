import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@slate/ui';

import { adminServices } from '@/server/admin/runtime';
import { requireActor } from '@/server/session';

import { assignRoleAction } from '../actions';
import { outcomeBanner, type SearchParams } from '../search-params';

export const dynamic = 'force-dynamic';

interface UsersPageProps {
  readonly searchParams: Promise<SearchParams>;
}

/** User and role administration with the escalation guard (ADR 010 §3). */
export default async function UsersPage({ searchParams }: UsersPageProps) {
  const actor = await requireActor();
  const params = await searchParams;
  const { users } = await adminServices();
  const [members, roles] = await Promise.all([users.listUsers(actor), users.listRoles(actor)]);
  const message = outcomeBanner(params, 'assigned', 'Role assigned.');

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Users & roles</h1>
        <p className="text-sm text-muted-foreground">
          A role can only be assigned when every permission it carries is one you hold yourself; a
          grant that would escalate privilege is refused server-side.
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
          <CardTitle as="h2">Members</CardTitle>
          <CardDescription>{members.length} member(s) in the active tenant.</CardDescription>
        </CardHeader>
        <CardContent>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Users in the active tenant</caption>
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
              {members.map((member) => (
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

      <Card>
        <CardHeader>
          <CardTitle as="h2">Assign a role</CardTitle>
          <CardDescription>
            The write is audited with one attributable row; a refused escalation changes nothing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={assignRoleAction} className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="assign-user" className="text-sm text-muted-foreground">
                Member
              </label>
              <select
                id="assign-user"
                name="userId"
                required
                className="h-10 rounded-md border border-border bg-background px-2 text-sm text-foreground"
              >
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.email}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="assign-role" className="text-sm text-muted-foreground">
                Role
              </label>
              <select
                id="assign-role"
                name="roleId"
                required
                className="h-10 rounded-md border border-border bg-background px-2 text-sm text-foreground"
              >
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" variant="primary">
              Assign role
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">Roles</CardTitle>
          <CardDescription>Permissions each role carries in this tenant.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2 text-sm">
            {roles.map((role) => (
              <li key={role.id} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
                <p className="font-medium text-foreground">{role.name}</p>
                <p className="text-muted-foreground">
                  {role.permissionKeys.length === 0
                    ? 'No permissions'
                    : role.permissionKeys.join(', ')}
                </p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
