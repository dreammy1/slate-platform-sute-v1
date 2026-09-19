import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '../index.ts';
import { expectNoA11yViolations } from './a11y.ts';

describe('Button', () => {
  it('renders a real button with its accessible name and a safe default type', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.tagName).toBe('BUTTON');
    // The default matters: an untyped button submits whatever form contains it.
    expect(button.getAttribute('type')).toBe('button');
  });

  it('submits only when the caller asks for it', () => {
    render(
      <form>
        <Button>Cancel</Button>
        <Button type="submit">Send</Button>
      </form>,
    );
    expect(screen.getByRole('button', { name: 'Cancel' }).getAttribute('type')).toBe('button');
    expect(screen.getByRole('button', { name: 'Send' }).getAttribute('type')).toBe('submit');
  });

  it('expresses the variant and size as token-backed utility classes', () => {
    render(
      <Button variant="danger" size="lg">
        Delete
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button.className).toContain('bg-danger');
    expect(button.className).toContain('h-11');
    expect(button.className).toContain('focus-visible:ring-ring');
  });

  it("lets a caller's utility win instead of emitting both", () => {
    render(<Button className="px-10">Wide</Button>);
    const className = screen.getByRole('button', { name: 'Wide' }).className;
    expect(className).toContain('px-10');
    expect(className).not.toContain('px-4');
  });

  it('renders the child element as the control when asChild is set', () => {
    render(
      <Button asChild>
        <a href="/settings">Settings</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Settings' });
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/settings');
    // A link that navigates must not also announce itself as a button.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('reports clicks and honours the disabled state', () => {
    const onClick = vi.fn();
    render(
      <>
        <Button onClick={onClick}>Go</Button>
        <Button disabled>Stop</Button>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<Button>Save</Button>);
    await expectNoA11yViolations(container);
  });
});
