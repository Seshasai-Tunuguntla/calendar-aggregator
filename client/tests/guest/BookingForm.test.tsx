import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../../src/api/client.ts';
import { BookingForm, type GuestDetails } from '../../src/guest/BookingForm.tsx';

const SLOT = { start: '2026-10-13T08:30:00.000Z', end: '2026-10-13T09:00:00.000Z' };

function renderForm(onSubmit = vi.fn<(d: GuestDetails) => Promise<void>>().mockResolvedValue(undefined), timeZone = 'Asia/Dubai') {
  render(<BookingForm slot={SLOT} timeZone={timeZone} hostName="Priya Sharma" hostTimeZone="Asia/Kolkata" onSubmit={onSubmit} />);
  return onSubmit;
}

describe('BookingForm', () => {
  it("names the picked time in the guest's zone, and the host's clock when it differs", () => {
    renderForm();
    // 08:30 UTC: 12:30 in Dubai, 14:00 in India.
    // Guests see dates in their browser's language, so either order is right.
    expect(screen.getByRole('heading', { name: /^Tuesday,? (13 October|October 13), 12:30\sPM–1:00\sPM$/ })).toHaveFocus();
    expect(screen.getByText(/That's 2:00\sPM for Priya Sharma\./)).toBeInTheDocument();
  });

  it("doesn't mention the host's clock when it's the same (even under another name for the zone)", () => {
    renderForm(undefined, 'Asia/Calcutta');
    expect(screen.queryByText(/for Priya Sharma/)).not.toBeInTheDocument();
  });

  it('asks for a name and a valid email before sending anything', async () => {
    const onSubmit = renderForm();
    await userEvent.click(screen.getByRole('button', { name: 'Book this time' }));
    expect(screen.getByText('Enter your name')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Your name')).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Your name'), 'Alex Kim');
    await userEvent.type(screen.getByLabelText('Email for the invitation'), 'alex@');
    await userEvent.click(screen.getByRole('button', { name: 'Book this time' }));
    expect(screen.queryByText('Enter your name')).not.toBeInTheDocument();
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByLabelText('Email for the invitation')).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends the details tidied (trimmed, email lowercased)', async () => {
    const onSubmit = renderForm();
    await userEvent.type(screen.getByLabelText('Your name'), '  Alex Kim ');
    await userEvent.type(screen.getByLabelText('Email for the invitation'), ' Alex@Example.COM');
    await userEvent.click(screen.getByRole('button', { name: 'Book this time' }));
    expect(onSubmit).toHaveBeenCalledWith({ guestName: 'Alex Kim', guestEmail: 'alex@example.com' });
  });

  it("shows why booking failed, so the guest can try again", async () => {
    renderForm(vi.fn<(d: GuestDetails) => Promise<void>>().mockRejectedValue(new ApiRequestError(503, "We couldn't add this to Priya Sharma's calendar, so nothing was booked.")));
    await userEvent.type(screen.getByLabelText('Your name'), 'Alex Kim');
    await userEvent.type(screen.getByLabelText('Email for the invitation'), 'alex@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Book this time' }));
    expect(await screen.findByText(/so nothing was booked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book this time' })).toBeEnabled();
  });
});
