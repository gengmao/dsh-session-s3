export class S3LogError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ConfigError extends S3LogError {
  readonly issues: string[];

  constructor(issues: string[]) {
    const unique = [...new Set(issues.filter(Boolean))];
    super(`invalid dsh-session-s3 config: ${unique.join("; ")}`, "CONFIG");
    this.issues = unique;
  }
}

export class ManifestCorruptError extends S3LogError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "MANIFEST_CORRUPT", options);
  }
}

export class FragmentCorruptError extends S3LogError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "FRAGMENT_CORRUPT", options);
  }
}

export class CasConflictError extends S3LogError {
  constructor(message = "S3 CAS precondition failed (412)") {
    super(message, "CAS_CONFLICT");
  }
}

export class CasRetryExhaustedError extends S3LogError {
  readonly attempts: number;

  constructor(key: string, attempts: number) {
    super(`CAS update of ${key} failed after ${attempts} attempts`, "CAS_RETRY_EXHAUSTED");
    this.attempts = attempts;
  }
}

export class S3AccessError extends S3LogError {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number, options?: ErrorOptions) {
    super(message, "S3_ACCESS", options);
    this.statusCode = statusCode;
  }
}

/**
 * A writer observed a newer committed prefix inside the manifest CAS.
 * DSH is single-writer-per-session; this is fail-closed, not a merge.
 * The fragment already PUT is an unreachable orphan.
 */
export class StaleWriterError extends S3LogError {
  readonly sessionId: string;
  readonly expected: number;
  readonly got: number;

  constructor(sessionId: string, expected: number, got: number) {
    super(
      `stale writer for "${sessionId}": expected SessionEvent.seq ${expected}, got ${got}`,
      "STALE_WRITER",
    );
    this.sessionId = sessionId;
    this.expected = expected;
    this.got = got;
  }
}
