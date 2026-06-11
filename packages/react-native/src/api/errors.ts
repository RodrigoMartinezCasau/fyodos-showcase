/**
 * Typed API errors. The original client classified failures by matching
 * Spanish substrings in error messages — language-dependent and fragile.
 * The Fyodos client throws AgentApiError with a stable machine code; the
 * orchestrator maps codes to the locale UI catalog.
 */

export type AgentApiErrorCode =
  | 'timeout'
  | 'cancelled'
  | 'unauthorized'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'not_found'
  | 'server_error'
  | 'network'
  | 'invalid_response'
  | 'unknown';

export class AgentApiError extends Error {
  readonly code: AgentApiErrorCode;
  readonly status?: number;

  constructor(code: AgentApiErrorCode, message?: string, status?: number) {
    super(message ?? code);
    this.name = 'AgentApiError';
    this.code = code;
    this.status = status;
  }
}

export function isAgentApiError(err: unknown): err is AgentApiError {
  return err instanceof AgentApiError;
}
