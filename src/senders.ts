import { type Env, AppError } from './types';

export type SenderSlot = 'owner' | 'friend';
export function senderSlot(value: unknown): SenderSlot {
  if (value === undefined || value === null || value === 'owner') return 'owner';
  if (value === 'friend') return 'friend';
  throw new AppError('invalid_sender_slot');
}
export function senderForSlot(env: Env, slot: SenderSlot): string | undefined {
  return slot === 'owner' ? env.OWNER_IG_SENDER_ID : env.FRIEND_IG_SENDER_ID;
}
export function approvedSenders(env: Env): string[] {
  const ids = [env.OWNER_IG_SENDER_ID, env.FRIEND_IG_SENDER_ID].filter((id): id is string => !!id);
  if (ids.some(id => !/^\d{1,40}$/.test(id)) || new Set(ids).size !== ids.length) throw new AppError('invalid_sender_allowlist');
  return ids;
}
export function sendersReady(env: Env): boolean { return approvedSenders(env).length === 2; }
export function senderAllowed(env: Env, id: string): boolean { return sendersReady(env) && approvedSenders(env).includes(id); }
