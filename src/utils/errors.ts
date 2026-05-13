export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== 'object') return String(error);

  const payload = error as {
    message?: unknown;
    code?: unknown;
    details?: unknown;
    hint?: unknown;
    status?: unknown;
    statusText?: unknown;
  };

  const parts = [
    payload.message,
    payload.code ? `code: ${payload.code}` : '',
    payload.details ? `details: ${payload.details}` : '',
    payload.hint ? `hint: ${payload.hint}` : '',
    payload.status ? `status: ${payload.status}` : '',
    payload.statusText ? `statusText: ${payload.statusText}` : '',
  ].filter(Boolean);

  if (parts.length > 0) return parts.join('；');

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
