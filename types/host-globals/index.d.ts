/**
 * Host-neutral globals: present in every JavaScript host (browsers, Node, Deno, Bun, workers).
 *
 * Headless packages are compiled with `lib: ["ES2022"]` and `types: ["host-globals"]` instead of the DOM lib or
 * `@types/node`, so anything beyond these — `window`, `document`, `HTMLElement`, `node:*` modules, `process` — does
 * NOT typecheck unless the package opts in explicitly (`lib: ["DOM"]` / `types: ["node"]`). That keeps the
 * "core is platform-independent" rule (brief §4) visible to the compiler, not only to a review.
 *
 * Packages that enable the DOM lib or @types/node get console/timers from there and must not also list `host-globals`.
 */

declare const console: {
  log(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
  debug(...data: unknown[]): void;
};

/** Opaque timer handle: a number in browsers, an object in Node. Only pass it back to clearTimeout/clearInterval. */
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;
declare function clearTimeout(handle: any): void;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;
declare function clearInterval(handle: any): void;
declare function queueMicrotask(callback: () => void): void;
