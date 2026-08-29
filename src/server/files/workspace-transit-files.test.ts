import type { WorkspaceFilesystemLike } from "./workspace-transit-files.ts";

import { beforeEach, describe, expect, it } from "vitest";
import { TransitFileError } from "./transit-file-store.ts";
import { WorkspaceTransitFileService } from "./workspace-transit-files.ts";

class MemoryWorkspaceFilesystem implements WorkspaceFilesystemLike {
  readonly files = new Map<string, Buffer>();

  async readFile(path: string, options?: { encoding?: "utf-8" | "binary" }): Promise<string | Buffer> {
    const value = this.files.get(normalize(path));
    if (!value) {
      throw new Error(`ENOENT: ${path}`);
    }
    return options?.encoding === "utf-8" ? value.toString("utf8") : value;
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    this.files.set(normalize(path), typeof content === "string" ? Buffer.from(content) : Buffer.from(content));
  }

  async deleteFile(path: string, options?: { force?: boolean }): Promise<void> {
    const key = normalize(path);
    if (!this.files.has(key) && !options?.force) {
      throw new Error(`ENOENT: ${path}`);
    }
    this.files.delete(key);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(normalize(path));
  }
}

function normalize(path: string): string {
  return path.replace(/\/+/g, "/");
}

describe("WorkspaceTransitFileService", () => {
  let filesystem: MemoryWorkspaceFilesystem;
  let service: WorkspaceTransitFileService;

  beforeEach(() => {
    filesystem = new MemoryWorkspaceFilesystem();
    service = new WorkspaceTransitFileService({
      filesystem,
      publicOrigin: "https://connect.example",
      ttlSeconds: 3600,
      maxBytes: 1024,
    });
  });

  it("stores and reads files through the workspace filesystem", async () => {
    const created = await service.create(new File(["hello workspace"], "note.txt", { type: "text/plain" }));
    expect(created.downloadUrl).toBe(`https://connect.example/api/files/${created.fileId}`);
    expect(filesystem.files.has(`/transit/${created.fileId}`)).toBe(true);
    expect(filesystem.files.has(`/transit/${created.fileId}.meta.json`)).toBe(true);

    const read = await service.read(created.fileId);
    expect(read.name).toBe("note.txt");
    expect(read.mimeType).toBe("text/plain");
    expect(await read.file.text()).toBe("hello workspace");
  });

  it("rejects oversized uploads", async () => {
    const serviceTiny = new WorkspaceTransitFileService({
      filesystem,
      publicOrigin: "https://connect.example",
      ttlSeconds: 3600,
      maxBytes: 4,
    });
    await expect(serviceTiny.create(new File(["too-big"], "big.bin"))).rejects.toBeInstanceOf(TransitFileError);
  });

  it("deletes object and metadata", async () => {
    const created = await service.create(new File(["x"], "x.bin"));
    await expect(service.delete(created.fileId)).resolves.toBe(true);
    await expect(service.read(created.fileId)).rejects.toMatchObject({ status: 404 });
  });
});
