import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Button, Modal } from '../index.ts';
import { expectNoA11yViolations } from './a11y.ts';

const TITLE = 'Delete project';
const DESCRIPTION = 'This cannot be undone.';

function renderModal(description: string | undefined = DESCRIPTION) {
  return render(
    <Modal
      title={TITLE}
      description={description}
      trigger={<Button>Delete</Button>}
      footer={<Button variant="danger">Confirm</Button>}
    >
      <p>All requests and their audit trail go too.</p>
    </Modal>,
  );
}

describe('Modal', () => {
  it('opens from its trigger and names itself after the title', async () => {
    renderModal();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog', { name: TITLE });
    // `aria-modal` is what tells assistive technology the rest of the page is inert.
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText(DESCRIPTION)).toBeTruthy();
    expect(screen.getByText('All requests and their audit trail go too.')).toBeTruthy();
  });

  it('moves focus into the dialog and returns it to the trigger on close', async () => {
    renderModal();
    const trigger = screen.getByRole('button', { name: 'Delete' });
    trigger.focus();

    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // Focus restoration is the primitive's job; losing it strands keyboard users.
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it('closes through the labelled close control', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('reports open changes to the caller', async () => {
    const onOpenChange = vi.fn();
    render(
      <Modal title={TITLE} onOpenChange={onOpenChange} trigger={<Button>Open</Button>}>
        <p>Body</p>
      </Modal>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('dialog');

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('is still named and free of violations without a description', async () => {
    // Rendered inline rather than through `renderModal(undefined)`: an explicit
    // `undefined` argument would fall through to that helper's default, which is
    // exactly the description-present case this test must not use.
    render(
      <Modal
        title={TITLE}
        trigger={<Button>Delete</Button>}
        footer={<Button variant="danger">Confirm</Button>}
      >
        <p>All requests and their audit trail go too.</p>
      </Modal>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: TITLE });
    // No dangling `aria-describedby`, which would leave a screen reader pointing
    // at an element that does not exist.
    expect(dialog.getAttribute('aria-describedby')).toBeNull();

    await expectNoA11yViolations(document.body);
  });

  it('has no accessibility violations while open', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByRole('dialog');

    await expectNoA11yViolations(document.body);
  });
});
