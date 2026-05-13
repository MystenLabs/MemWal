declare module "k6/http" {
    export type Response = {
        status: number;
        body: unknown;
        timings: { duration: number };
        json: () => unknown;
    };

    type Params = {
        headers?: Record<string, string>;
        tags?: Record<string, string>;
        timeout?: string;
    };

    const http: {
        get: (url: string, params?: Params) => Response;
        request: (
            method: string,
            url: string,
            body?: string | null,
            params?: Params,
        ) => Response;
    };

    export default http;
}

declare module "k6/execution" {
    const exec: {
        vu: { idInTest: number };
        scenario: { iterationInTest: number };
    };
    export default exec;
}

declare module "k6" {
    import type { Response } from "k6/http";

    export function check<T = Response>(
        value: T,
        sets: Record<string, (value: T) => boolean>,
    ): boolean;
    export function fail(message: string): never;
    export function sleep(seconds: number): void;
}

declare module "k6/metrics" {
    export class Counter {
        constructor(name: string);
        add(value: number, tags?: Record<string, string>): void;
    }

    export class Rate {
        constructor(name: string);
        add(value: boolean, tags?: Record<string, string>): void;
    }

    export class Trend {
        constructor(name: string, isTime?: boolean);
        add(value: number, tags?: Record<string, string>): void;
    }
}
