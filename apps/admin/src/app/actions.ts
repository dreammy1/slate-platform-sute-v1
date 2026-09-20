'use server';

/**
 * Server actions for the admin modules (SLATE-302, ADR 010).
 *
 * Every action re-resolves the session server-side, authorizes inside the
 * service, and redirects back with a plain-text outcome — no client state, no
 * client-supplied tenant, no authority in the browser (Sections 13, 61).
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { adminServices } from '@/server/admin/runtime';
import { requireActor } from '@/server/session';

/** An error shape the admin services raise: a status plus a safe message. */
interface StatusError {
  readonly status: number;
  readonly message: string;
}

function hasStatus(error: unknown): error is StatusError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { status?: unknown; message?: unknown };
  return typeof candidate.status === 'number' && typeof candidate.message === 'string';
}

/** Only our own (safe) messages are surfaced; anything else is generic. */
function failureMessage(error: unknown): string {
  return hasStatus(error) ? error.message : 'The request could not be completed.';
}

export async function createTenantAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let outcome: string;
  try {
    const services = await adminServices();
    await services.tenants.createTenant(actor, {
      name: formData.get('name'),
      slug: formData.get('slug'),
    });
    outcome = 'created=1';
  } catch (error) {
    outcome = `error=${encodeURIComponent(failureMessage(error))}`;
  }
  revalidatePath('/tenants');
  redirect(`/tenants?${outcome}`);
}

export async function assignRoleAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let outcome: string;
  try {
    const services = await adminServices();
    await services.users.assignRole(actor, {
      userId: formData.get('userId'),
      roleId: formData.get('roleId'),
    });
    outcome = 'assigned=1';
  } catch (error) {
    outcome = `error=${encodeURIComponent(failureMessage(error))}`;
  }
  revalidatePath('/users');
  redirect(`/users?${outcome}`);
}

export async function setFeatureFlagAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let outcome: string;
  try {
    const services = await adminServices();
    await services.flags.setOverride(actor, {
      key: formData.get('key'),
      enabled: formData.get('enabled'),
    });
    outcome = 'saved=1';
  } catch (error) {
    outcome = `error=${encodeURIComponent(failureMessage(error))}`;
  }
  revalidatePath('/features');
  redirect(`/features?${outcome}`);
}
