import { timerDelayMs } from '../domain/mutes.ts';

interface Scheduled {
  guildId: string;
  timer: NodeJS.Timeout;
}

/**
 * One in-process timer per active mute, for removing the marker role and promoting
 * the queue at `ends_at`. Discord lifts the timeout itself; the DB is the source of
 * truth and this is just a cache of it, rebuilt on startup.
 */
export class MuteScheduler {
  private readonly timers = new Map<string, Scheduled>();
  private readonly onDue: (muteId: string) => Promise<void>;
  private readonly onError: (err: unknown, muteId: string) => void;

  constructor(onDue: (muteId: string) => Promise<void>, onError: (err: unknown, muteId: string) => void) {
    this.onDue = onDue;
    this.onError = onError;
  }

  schedule(mute: { id: string; guildId: string; endsAt: Date }): void {
    this.cancel(mute.id);
    const delay = timerDelayMs(mute.endsAt, new Date());
    const timer = setTimeout(() => {
      this.timers.delete(mute.id);
      // Past Node's max timer length, re-arm instead of firing early.
      if (mute.endsAt.getTime() > Date.now() + 1000) return this.schedule(mute);
      this.onDue(mute.id).catch((e: unknown) => this.onError(e, mute.id));
    }, delay);
    timer.unref();
    this.timers.set(mute.id, { guildId: mute.guildId, timer });
  }

  cancel(muteId: string): void {
    const s = this.timers.get(muteId);
    if (s) clearTimeout(s.timer);
    this.timers.delete(muteId);
  }

  cancelGuild(guildId: string): void {
    for (const [id, s] of this.timers) if (s.guildId === guildId) this.cancel(id);
  }

  get size(): number {
    return this.timers.size;
  }

  stop(): void {
    for (const id of [...this.timers.keys()]) this.cancel(id);
  }
}
