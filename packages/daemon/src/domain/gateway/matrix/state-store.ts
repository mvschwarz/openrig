import fs from "node:fs";
import path from "node:path";

/** One atomic snapshot per connector store; a failed write keeps the old state
 * in memory too. No sync token is advanced before the corresponding events land. */
export class JsonStore<T> {
  private value: T;
  constructor(private readonly file: string, empty: T) {
    try { this.value = JSON.parse(fs.readFileSync(file, "utf8")) as T; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.value = empty;
    }
  }
  read(): T { return this.value; }
  write(value: T): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(value) + "\n", { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
    this.value = value;
  }
}
