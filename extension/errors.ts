export function errorFromCause(cause: unknown): Error {
	if (cause instanceof Error) return cause;

	return new Error(String(cause), { cause });
}
