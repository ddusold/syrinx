import type { App, StandardSchemaV1, View } from "@syrinx/core";
import type { ViewEmit, ViewProps } from "./types.js";

type OperationsOf<A extends App> = A["operations"];
type OperationName<A extends App> = keyof OperationsOf<A> & string;
type ViewOf<A extends App, Name extends keyof A["views"]> = A["views"][Name];

/** What a caller passes to an operation: its input schema before defaults and transforms apply. */
export type OperationInput<A extends App, K extends OperationName<A>> = StandardSchemaV1.InferInput<
  OperationsOf<A>[K]["input"]
>;

/** What an operation returns to a view: the shape its handler produces, as JSON carries it. */
export type OperationOutput<A extends App, K extends OperationName<A>> = StandardSchemaV1.InferInput<
  OperationsOf<A>[K]["output"]
>;

/** The operations a view declares in `calls`, by name (`list`), leaving out other apps' (`exports.new`). */
export type ViewCalls<A extends App, Name extends keyof A["views"]> =
  ViewOf<A, Name> extends View<string, infer C> ? Extract<C, OperationName<A>> : never;

/** The operations a view is bound to, and so the shapes its `data` can take. */
export type ViewBound<A extends App, Name extends keyof A["views"]> =
  ViewOf<A, Name> extends View<infer B> ? Extract<B, OperationName<A>> : never;

/** The union of what the bound operations return: the type of `view.data`. */
export type ViewDataOf<A extends App, Name extends keyof A["views"]> = {
  [K in ViewBound<A, Name>]: OperationOutput<A, K>;
}[ViewBound<A, Name>];

// An input every field of which is optional may be left out; any other must be given.
/* eslint-disable @typescript-eslint/no-generated-empty-object-type -- an input of only optional fields is `{}` */
type CallArgs<A extends App, K extends OperationName<A>> =
  Partial<OperationInput<A, K>> extends OperationInput<A, K>
    ? [input?: OperationInput<A, K>]
    : [input: OperationInput<A, K>];
/* eslint-enable @typescript-eslint/no-generated-empty-object-type */

/**
 * `emit` with `call` checked against the app: only the operations the view lists in `calls`, with their input and
 * output types. Another app's operation (`exports.new`) stays untyped, since its app is not known here.
 */
export interface TypedEmit<A extends App, Name extends keyof A["views"]> extends Omit<ViewEmit, "call"> {
  call<K extends ViewCalls<A, Name>>(operation: K, ...input: CallArgs<A, K>): Promise<OperationOutput<A, K>>;
  call<T = unknown>(operation: `${string}.${string}`, input?: unknown): Promise<T>;
}

/** {@link ViewProps} for one view of an app, from the app's own types: typed `data` and typed `emit.call`. */
export type TypedViewProps<A extends App, Name extends keyof A["views"]> = Omit<
  ViewProps<ViewDataOf<A, Name>>,
  "emit"
> & { readonly emit: TypedEmit<A, Name> };
