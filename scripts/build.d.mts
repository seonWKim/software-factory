// Types for scripts/build.mjs, so tests can import it.
export function alive(pid: number): boolean;
export function sweep(target: string): void;
export function stagingPath(target: string): string;
export function withLock<T>(dir: string, fn: () => T): T;
export function swapIn(staged: string, target: string): void;
export function viteBuildArgs(root: string, outDir: string): string[];
export function build(root: string): void;
