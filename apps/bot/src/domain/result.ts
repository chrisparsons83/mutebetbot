export type Ok<T> = { ok: true } & T;
export type Err<E extends string, D = object> = { ok: false; error: E } & D;

export const ok = <T extends object>(value: T): Ok<T> => ({ ok: true, ...value });
export function err<E extends string>(error: E): Err<E>;
export function err<E extends string, D extends object>(error: E, detail: D): Err<E, D>;
export function err<E extends string, D extends object>(error: E, detail?: D): Err<E, D> {
  return { ok: false, error, ...(detail ?? ({} as D)) };
}

export const addSeconds = (d: Date, s: number): Date => new Date(d.getTime() + s * 1000);
export const secondsBetween = (from: Date, to: Date): number => Math.max(0, Math.ceil((to.getTime() - from.getTime()) / 1000));
