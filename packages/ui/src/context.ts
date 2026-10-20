import type { StandardSchemaV1 } from "@syrinx/core";

/**
 * Typed state shared by every part of one rendered view, including views embedded from other apps. Declared once
 * by the app that owns it; the composite view provides it, and any part reads or writes it.
 */
export interface ViewContextDef<State = unknown, Payload = unknown> {
  readonly name: string;
  /** Checks every value written, so a part from another app cannot store a malformed state. */
  readonly schema?: StandardSchemaV1<State>;
  /**
   * The first state, seeded from the data that opened the view. Called with undefined while the host has not
   * delivered it yet, and again with the first data when it arrives.
   */
  initial(payload: Payload | undefined): State;
  /**
   * The state after new data arrives, such as a refreshed list after a call. Defaults to keeping the current state,
   * so selections survive a refresh; return a new state to follow the data instead.
   */
  merge?(current: State, payload: Payload): State;
}

export function defineViewContext<State, Payload = unknown>(
  def: ViewContextDef<State, Payload>,
): ViewContextDef<State, Payload> {
  return Object.freeze({ ...def });
}

export interface ContextStore<State = unknown> {
  readonly def: ViewContextDef<State>;
  get(): State;
  set(next: State | ((current: State) => State)): void;
  subscribe(listener: (state: State) => void): () => void;
  /** Seeds from the first data if the store started without any, then applies the merge rule to later data. */
  refresh(payload: unknown): void;
}

function check<State>(def: ViewContextDef<State>, value: State): State {
  if (!def.schema) return value;
  const result = def.schema["~standard"].validate(value);
  if (result instanceof Promise) throw new TypeError(`View context "${def.name}" needs a synchronous schema.`);
  if (result.issues) {
    const issues = result.issues.map((i) => i.message).join("; ");
    throw new TypeError(`View context "${def.name}" rejected a value: ${issues}`);
  }
  return result.value;
}

/** A small observable store. Framework bindings subscribe to it; it lives as long as the view's iframe. */
export function createContextStore<State, Payload>(
  def: ViewContextDef<State, Payload>,
  payload: Payload | undefined,
): ContextStore<State> {
  const listeners = new Set<(state: State) => void>();
  let state = check(def as ViewContextDef<State>, def.initial(payload));
  let seeded = payload !== undefined;
  const write = (next: State) => {
    const checked = check(def as ViewContextDef<State>, next);
    if (Object.is(checked, state)) return;
    state = checked;
    for (const listener of [...listeners]) listener(state);
  };
  return {
    def: def,
    get: () => state,
    set: (next) => {
      write(typeof next === "function" ? (next as (current: State) => State)(state) : next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh(next) {
      if (next === undefined) return;
      if (!seeded) {
        seeded = true;
        write(def.initial(next as Payload));
      } else if (def.merge) {
        write(def.merge(state, next as Payload));
      }
    },
  };
}

/**
 * The providers above a point in the view tree, nearest first. Immutable: providing a context returns a new scope,
 * so siblings never see each other's providers.
 */
export interface ContextScope {
  find<State>(def: ViewContextDef<State, never>): ContextStore<State> | undefined;
  with<State>(store: ContextStore<State>): ContextScope;
}

function scope(store: ContextStore | undefined, parent: ContextScope | undefined): ContextScope {
  const self: ContextScope = {
    find: <State>(def: ViewContextDef<State, never>) =>
      store?.def.name === def.name ? (store as unknown as ContextStore<State>) : parent?.find(def),
    with: (next) => scope(next as unknown as ContextStore, self),
  };
  return self;
}

export const emptyScope: ContextScope = scope(undefined, undefined);
