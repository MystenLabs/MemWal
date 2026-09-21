function installErrorPrototype(error: Error, ctor: Function): void {
    error.name = ctor.name;
    Object.setPrototypeOf(error, ctor.prototype);
}

/** HTTP 429 from a signed relayer request. */
export class RateLimitError extends Error {
    readonly status = 429 as const;
    readonly retryAfterSeconds?: number;

    constructor(message: string, retryAfterSeconds?: number) {
        super(message);
        this.retryAfterSeconds = retryAfterSeconds;
        installErrorPrototype(this, new.target);
    }
}

/** Base class for waitForRememberJob / rememberAndWait job failures. */
export class RememberJobError extends Error {
    readonly status: 404 | 500 | 504;
    readonly jobId: string;

    constructor(message: string, status: 404 | 500 | 504, jobId: string) {
        super(message);
        this.status = status;
        this.jobId = jobId;
        installErrorPrototype(this, new.target);
    }
}

/** Polled job_id does not exist or is not owned by the caller. */
export class RememberJobNotFoundError extends RememberJobError {
    readonly status = 404 as const;

    constructor(jobId: string) {
        super(`remember job not found: ${jobId}`, 404, jobId);
    }
}

/** Async remember job reached terminal status=failed. */
export class RememberJobFailedError extends RememberJobError {
    readonly status = 500 as const;
    readonly error: string;

    constructor(jobId: string, error: string) {
        super(`remember job failed: ${error}`, 500, jobId);
        this.error = error;
    }
}

/**
 * Thrown by `waitForRememberJob` / `rememberAndWait` when polling misses the
 * deadline. `waitForRememberJobs` does not throw for that case; leftover items
 * resolve with `status: "timeout"`.
 */
export class RememberJobTimeoutError extends RememberJobError {
    readonly status = 504 as const;
    readonly timeoutMs: number;

    constructor(jobId: string, timeoutMs: number) {
        super(`remember job timed out after ${timeoutMs}ms (job_id=${jobId})`, 504, jobId);
        this.timeoutMs = timeoutMs;
    }
}

export function relayerHttpError(
    status: number,
    message: string,
    opts: { serverCode?: string; retryAfterSeconds?: number; cause?: string } = {},
): Error {
    if (status === 429) {
        return new RateLimitError(message, opts.retryAfterSeconds);
    }
    const err = new Error(message) as Error & {
        status?: number;
        serverCode?: string;
        retryAfterSeconds?: number;
        cause?: string;
    };
    err.status = status;
    if (opts.serverCode) err.serverCode = opts.serverCode;
    if (opts.retryAfterSeconds !== undefined) err.retryAfterSeconds = opts.retryAfterSeconds;
    if (opts.cause !== undefined) err.cause = opts.cause;
    return err;
}
