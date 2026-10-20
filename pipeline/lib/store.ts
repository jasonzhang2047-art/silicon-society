import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA = join(process.cwd(), "data");

export function readData<T>(file: string, fallback: T): T {
  const p = join(DATA, file);
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

export function writeData(file: string, value: unknown) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, file), JSON.stringify(value, null, 1) + "\n");
}
