import { describe, expect, it } from 'vitest';
import { parseConfigSet } from './config.ts';

describe('parseConfigSet', () => {
  it('converts every option', () => {
    const r = parseConfigSet({
      max_concurrent_mutes: 5,
      token_expiry: 'never',
      allowed_durations: '24h, 30m,1h,1h',
      confirm_window: '1d 12h',
      target_cooldown: '0',
      max_open_proposals_per_user: 2,
      unmutable_members: 'reject',
      rejoin_policy: 'resume_remaining',
      admin_role: '123',
      announce_channel: '456',
      enabled: false,
    });
    expect(r.errors).toEqual([]);
    expect(r.patch).toEqual({
      maxConcurrentMutes: 5,
      tokenExpiry: 'never',
      allowedDurations: ['30m', '1h', '24h'],
      confirmWindowS: 129_600,
      targetCooldownS: 0,
      maxOpenProposalsPerUser: 2,
      unmutableMembers: 'reject',
      rejoinPolicy: 'resume_remaining',
      adminRoleId: '123',
      announceChannelId: '456',
      enabled: false,
    });
  });

  it('returns an empty patch when nothing is given', () => {
    expect(parseConfigSet({})).toEqual({ patch: {}, errors: [] });
  });

  it('enforces the documented ranges', () => {
    expect(parseConfigSet({ max_concurrent_mutes: 26 }).errors).toHaveLength(1);
    expect(parseConfigSet({ confirm_window: '30m' }).errors[0]).toMatch(/between 1h and 14d/);
    expect(parseConfigSet({ confirm_window: '15d' }).errors).toHaveLength(1);
    expect(parseConfigSet({ target_cooldown: '8d' }).errors).toHaveLength(1);
    expect(parseConfigSet({ max_open_proposals_per_user: 0 }).errors).toHaveLength(1);
  });

  it('rejects bad durations and junk', () => {
    expect(parseConfigSet({ allowed_durations: '3h' }).errors).toHaveLength(1);
    expect(parseConfigSet({ allowed_durations: ' , ' }).errors).toHaveLength(1);
    expect(parseConfigSet({ confirm_window: 'soon' }).errors).toHaveLength(1);
  });

  it('clears the admin role and announce channel, but not with a value at the same time', () => {
    expect(parseConfigSet({ clear_admin_role: true, clear_announce_channel: true }).patch).toEqual({
      adminRoleId: null,
      announceChannelId: null,
    });
    expect(parseConfigSet({ admin_role: '1', clear_admin_role: true }).errors).toHaveLength(1);
  });
});
