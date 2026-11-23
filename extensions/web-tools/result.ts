/** A typed success/failure result for expected failures in local code. */
export type Result<T, E> =
	| { readonly _tag: "ok"; readonly value: T }
	| { readonly _tag: "err"; readonly error: E };

/** Construct a successful Result. */
export function ok<T>(value: T): Result<T, never> {
	return { _tag: "ok", value };
}

/** Construct a failed Result. */
export function err<E>(error: E): Result<never, E> {
	return { _tag: "err", error };
}
