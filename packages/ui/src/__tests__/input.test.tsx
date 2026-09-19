import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Input } from '../index.ts';
import { expectNoA11yViolations } from './a11y.ts';

describe('Input', () => {
  it('names the control through its label', () => {
    render(<Input label="Email" />);
    const input = screen.getByLabelText('Email');
    expect(input.tagName).toBe('INPUT');
    // The association is the component's job, not the caller's.
    expect(input.id).not.toBe('');
  });

  it('links helper text through aria-describedby', () => {
    render(<Input label="Email" hint="We never share it." />);
    const describedBy = screen.getByLabelText('Email').getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe('We never share it.');
  });

  it('marks the control invalid and announces the error text', () => {
    render(<Input label="Email" error="Email is required." />);
    const input = screen.getByLabelText('Email');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Email is required.');
    // The message is the description too, so meaning never rests on colour alone.
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
  });

  it('describes hint and error together when both are present', () => {
    render(<Input label="Email" hint="Work address." error="Email is required." />);
    const describedBy = screen.getByLabelText('Email').getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ')).toHaveLength(2);
  });

  it('renders a bare control when given no label', () => {
    render(<Input aria-label="Search" />);
    expect(screen.getByLabelText('Search')).toBeTruthy();
  });

  it('honours an explicit id and forwards changes', () => {
    const onChange = vi.fn();
    render(<Input id="email" label="Email" onChange={onChange} />);
    const input = document.getElementById('email');
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { value: 'ops@example.test' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <Input label="Email" hint="Work address." error="Email is required." />,
    );
    await expectNoA11yViolations(container);
  });
});
