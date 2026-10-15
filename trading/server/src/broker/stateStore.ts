import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface StateStore<T> {
  load(): T | undefined;
  save(state: T, immediate?: boolean): void;
}

/** JSON file persistence with debounced, atomic (write-then-rename) saves. */
export class JsonFileStore<T> implements StateStore<T> {
  private pending?: T;
  private timer?: NodeJS.Timeout;

  constructor(private readonly path: string, private readonly debounceMs = 500) {}

  load(): T | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as T;
    } catch (err) {
      console.error(`[store] could not read ${this.path}, starting fresh:`, err);
      return undefined;
    }
  }

  save(state: T, immediate = false): void {
    this.pending = state;
    if (immediate) return this.flush();
    this.timer ??= setTimeout(() => this.flush(), this.debounceMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending === undefined) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.pending));
    renameSync(tmp, this.path);
    this.pending = undefined;
  }
}
