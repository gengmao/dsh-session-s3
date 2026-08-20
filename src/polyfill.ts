/**
 * PersistenceCoordinator uses Promise.withResolvers (Node ≥ 22).
 * Keep a polyfill so accidental Node 18–21 loads don't crash at import.
 */
const PromiseCtor = Promise as typeof Promise & {
  withResolvers?: <T>() => {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
};

if (typeof PromiseCtor.withResolvers !== "function") {
  PromiseCtor.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

export {};
