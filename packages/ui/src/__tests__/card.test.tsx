import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../index.ts';
import { expectNoA11yViolations } from './a11y.ts';

describe('Card', () => {
  it('defaults to a third-level heading so a card cannot claim the page h1', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
        </CardHeader>
      </Card>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Usage' })).toBeTruthy();
  });

  it('renders the title at the level the screen asks for', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle as="h2">Usage</CardTitle>
        </CardHeader>
      </Card>,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'Usage' });
    expect(heading.tagName).toBe('H2');
  });

  it('renders description, content and footer', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
          <CardDescription>This month.</CardDescription>
        </CardHeader>
        <CardContent>42 requests</CardContent>
        <CardFooter>Updated hourly</CardFooter>
      </Card>,
    );
    expect(screen.getByText('This month.')).toBeTruthy();
    expect(screen.getByText('42 requests')).toBeTruthy();
    expect(screen.getByText('Updated hourly')).toBeTruthy();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardTitle as="h2">Usage</CardTitle>
          <CardDescription>This month.</CardDescription>
        </CardHeader>
        <CardContent>42 requests</CardContent>
      </Card>,
    );
    await expectNoA11yViolations(container);
  });
});
