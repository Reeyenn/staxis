import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { accountInviteDelivery, accountInviteStatus } from '@/lib/account-invites';
import { sendHotelAccountInvite } from '@/lib/email/hotel-account-invite';
import type { SendEmailParams } from '@/lib/email/resend';

describe('account invitation lifecycle', () => {
  test('distinguishes pending and expired invitations at the exact boundary', () => {
    const now = Date.parse('2026-07-20T12:00:00.000Z');
    assert.equal(accountInviteStatus('2026-07-20T12:00:00.001Z', now), 'pending');
    assert.equal(accountInviteStatus('2026-07-20T12:00:00.000Z', now), 'expired');
    assert.equal(accountInviteStatus('2026-07-20T11:59:59.999Z', now), 'expired');
    assert.equal(accountInviteStatus('not-a-date', now), 'expired');
  });

  test('reports a delivered email truthfully while retaining the invite link', () => {
    const delivery = accountInviteDelivery(
      'https://getstaxis.com/invite/secret',
      { ok: true, id: 'resend_123' },
    );
    assert.deepEqual(delivery, {
      inviteLink: 'https://getstaxis.com/invite/secret',
      emailSent: true,
      deliveryStatus: 'sent',
      emailError: null,
    });
  });

  test('returns a copyable-link fallback and never claims email was sent', () => {
    const delivery = accountInviteDelivery(
      'https://getstaxis.com/invite/secret',
      { ok: false, error: 'RESEND_API_KEY not configured' },
    );
    assert.equal(delivery.inviteLink, 'https://getstaxis.com/invite/secret');
    assert.equal(delivery.emailSent, false);
    assert.equal(delivery.deliveryStatus, 'link_only');
    assert.match(delivery.emailError ?? '', /copy the invitation link/i);
  });
});

describe('hotel account invitation email', () => {
  test('uses the transactional sender and preserves its successful result', async () => {
    let sentParams: SendEmailParams | null = null;
    const result = await sendHotelAccountInvite({
      to: 'manager@example.com',
      hotelName: 'Grand Harbor Hotel',
      role: 'general_manager',
      inviteUrl: 'https://getstaxis.com/invite/token',
      expiresAt: '2026-07-27T12:00:00.000Z',
    }, async (params) => {
      sentParams = params;
      return { ok: true, id: 'resend_delivery_1' };
    });

    assert.deepEqual(result, { ok: true, id: 'resend_delivery_1' });
    assert.ok(sentParams);
    const delivered = sentParams as SendEmailParams;
    assert.equal(delivered.to, 'manager@example.com');
    assert.match(delivered.subject, /Grand Harbor Hotel/);
    assert.match(delivered.text ?? '', /General Manager/);
    assert.match(delivered.html, /https:\/\/getstaxis\.com\/invite\/token/);
    assert.match(delivered.idempotencyKey ?? '', /^hotel-account-invite:/);
  });

  test('preserves a delivery failure for the route to expose as link-only', async () => {
    const result = await sendHotelAccountInvite({
      to: 'manager@example.com',
      hotelName: 'Grand Harbor Hotel',
      role: 'general_manager',
      inviteUrl: 'https://getstaxis.com/invite/token',
      expiresAt: '2026-07-27T12:00:00.000Z',
    }, async () => ({ ok: false, error: 'provider unavailable', status: 503 }));

    assert.deepEqual(result, { ok: false, error: 'provider unavailable', status: 503 });
  });

  test('neutralizes hotel-name header control characters before sending', async () => {
    let subject = '';
    await sendHotelAccountInvite({
      to: 'manager@example.com',
      hotelName: 'Grand Harbor\r\nBcc: attacker@example.com',
      role: 'general_manager',
      inviteUrl: 'https://getstaxis.com/invite/token',
      expiresAt: '2026-07-27T12:00:00.000Z',
    }, async (params) => {
      subject = params.subject;
      return { ok: true, id: 'resend_delivery_2' };
    });

    assert.doesNotMatch(subject, /[\r\n]/);
  });
});
