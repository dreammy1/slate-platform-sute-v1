import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  ADMIN_NAVIGATION,
  filterNavigation,
  Shell,
  TenantSwitcher,
  WEB_NAVIGATION,
} from '../index.ts';
import { expectNoA11yViolations } from './a11y.ts';

const TENANTS = [
  { id: 'tenant-a', name: 'Tenant A' },
  { id: 'tenant-b', name: 'Tenant B' },
];

function shell(permissions: readonly string[]) {
  return (
    <Shell
      appName="Slate Admin"
      navigation={filterNavigation(ADMIN_NAVIGATION, permissions)}
      activePath="/users"
      user={{ name: 'Ada', email: 'ada@example.test' }}
      tenantName="Tenant A"
      tenants={TENANTS}
      activeTenantId="tenant-a"
      requestId="req-1"
      tenantSwitcher={<TenantSwitcher tenants={TENANTS} activeTenantId="tenant-a" />}
      signOut={
        <form action="/sign-out">
          <button type="submit">Sign out</button>
        </form>
      }
      themeToggle={<button type="button">Theme</button>}
    >
      <h1>Users</h1>
    </Shell>
  );
}

describe('filterNavigation', () => {
  it('keeps public entries and drops anything the permission set lacks', () => {
    expect(filterNavigation(ADMIN_NAVIGATION, []).map((entry) => entry.id)).toEqual(['overview']);
    expect(filterNavigation(ADMIN_NAVIGATION, ['users.read']).map((entry) => entry.id)).toEqual([
      'overview',
      'users',
    ]);
    expect(filterNavigation(WEB_NAVIGATION, ['media.read']).map((entry) => entry.id)).toEqual([
      'overview',
      'media',
    ]);
  });
});

describe('Shell', () => {
  it('renders landmarks, the active entry, identity, and tenant context', () => {
    render(shell(['users.read']));
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Users' })[0]).toBeTruthy();
    expect(
      screen.getByText('Signed in as ada@example.test in Tenant A', { exact: false }),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(shell(['users.read', 'settings.read', 'jobs.read', 'media.read']));
    await expectNoA11yViolations(container);
  });
});

describe('TenantSwitcher', () => {
  it('lists membership tenants only and submits the chosen id', () => {
    const seen: string[] = [];
    render(
      <TenantSwitcher
        tenants={TENANTS}
        activeTenantId="tenant-a"
        onSwitch={(formData) => {
          seen.push(String(formData.get('tenantId')));
        }}
      />,
    );
    const select = screen.getByLabelText('Tenant') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Tenant A',
      'Tenant B',
    ]);
    fireEvent.change(select, { target: { value: 'tenant-b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch' }));
    expect(seen).toEqual(['tenant-b']);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<TenantSwitcher tenants={TENANTS} activeTenantId="tenant-a" />);
    await expectNoA11yViolations(container);
  });
});
