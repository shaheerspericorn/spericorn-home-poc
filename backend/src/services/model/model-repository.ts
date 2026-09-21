import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelRecord } from "../../types/model.js";

export class ModelRepository {
  private readonly filePath: string;
  private records = new Map<string, ModelRecord>();

  constructor(baseDirectory: string) {
    this.filePath = path.join(baseDirectory, "models.json");
  }

  async initialise(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const data = JSON.parse(await readFile(this.filePath, "utf8")) as ModelRecord[];
      this.records = new Map(data.map((record) => [record.id, record]));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(id: string): ModelRecord | undefined {
    return this.records.get(id);
  }

  async create(record: ModelRecord): Promise<ModelRecord> {
    this.records.set(record.id, record);
    await this.persist();
    return record;
  }

  async update(id: string, changes: Partial<ModelRecord>): Promise<ModelRecord | undefined> {
    const existing = this.records.get(id);
    if (!existing) return undefined;
    const next = { ...existing, ...changes, updatedAt: new Date().toISOString() };
    this.records.set(id, next);
    await this.persist();
    return next;
  }

  async delete(id: string): Promise<boolean> {
    const exists = this.records.delete(id);
    if (exists) await this.persist();
    return exists;
  }

  private writeQueue: Promise<void> = Promise.resolve();

  /** Writes are serialised: concurrent progress updates would otherwise race on the shared temporary file. */
  private persist(): Promise<void> {
    const write = async () => {
      const temporaryFile = `${this.filePath}.tmp`;
      await writeFile(temporaryFile, JSON.stringify([...this.records.values()], null, 2), "utf8");
      await rename(temporaryFile, this.filePath);
    };
    const next = this.writeQueue.then(write, write);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}
