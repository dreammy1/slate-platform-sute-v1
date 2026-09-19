/**
 * Tenant switcher form (SLATE-301, ADR 009 §3).
 *
 * Server-rendered `<form>` + `<select>`: the browser names a tenant, the
 * server action re-reads membership and refuses non-members (403) or re-issues
 * the session. No fetch, no storage, no client authority.
 */

import type { FormEvent } from 'react';

import { Button } from '../components/button.tsx';
import type { ShellTenantOption } from './shell.tsx';

/** What the layout wires to its server action: options plus submission. */
export interface TenantSwitcherProps {
  readonly tenants: readonly ShellTenantOption[];
  readonly activeTenantId: string;
  /** Server action (or action URL target); receives the chosen tenant id. */
  readonly onSwitch?: ((formData: FormData) => void) | undefined;
  readonly action?: string | undefined;
}

/**
 * Membership-only options in a labelled select plus a submit button. The
 * select carries the accessible name; the button submits natively (works with
 * or without JavaScript, and keyboard-first by construction).
 */
export function TenantSwitcher({ tenants, activeTenantId, onSwitch, action }: TenantSwitcherProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (onSwitch === undefined) return;
    event.preventDefault();
    onSwitch(new FormData(event.currentTarget));
  }

  return (
    <form
      aria-label="Switch tenant"
      {...(action === undefined ? {} : { action })}
      {...(onSwitch === undefined ? {} : { onSubmit: handleSubmit })}
      className="flex items-center gap-2"
    >
      <label htmlFor="tenant-switcher" className="text-sm text-muted-foreground">
        Tenant
      </label>
      <select
        id="tenant-switcher"
        name="tenantId"
        defaultValue={activeTenantId}
        className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
      >
        {tenants.map((tenant) => (
          <option key={tenant.id} value={tenant.id}>
            {tenant.name}
          </option>
        ))}
      </select>
      <Button type="submit" variant="secondary" size="sm">
        Switch
      </Button>
    </form>
  );
}
