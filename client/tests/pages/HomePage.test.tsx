import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomePage } from '../../src/pages/HomePage.tsx';

describe('HomePage', () => {
  it('reports the API as up when /api/health answers', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'ok' })));
    render(<HomePage />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking the API…');
    expect(await screen.findByText('API is up.')).toBeInTheDocument();
  });

  it('reports the API as unreachable when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')));
    render(<HomePage />);
    expect(await screen.findByText('The API is unreachable.')).toBeInTheDocument();
  });
});
