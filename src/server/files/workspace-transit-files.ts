import type { TransitFileRead, TransitFileUpload } from "../../core/types.ts";
import type { ITransitFileService } from "./transit-file-store.ts";

import { extname } from "node:path";
import { contentDispositionForFileName, contentTypeFromFileId, TransitFileError } from "./transit-file-store.ts";

/**
 * Minimal filesystem contract matching Mastra `WorkspaceFilesystem` file ops used for transit.
 * Pass a Mastra LocalFilesystem, S3Filesystem, GCS adapter, or any compatible implementation.
 */
export interface WorkspaceFilesystemLike {
  readFile(path: string, options?: { encoding?: "utf-8" | "binary" }): Promise<string | Buffer>;
  writeFile(
    path: string,
    content: string | Buffer,
    options?: { recursive?: boolean; overwrite?: boolean },
  ): Promise<void>;
  deleteFile(path: string, options?: { force?: boolean }): Promise<void>;
  exists?(path: string): Promise<boolean>;
  stat?(path: string): Promise<{ size: number; modifiedAt?: Date; mimeType?: string }>;
}

export interface WorkspaceTransitFileOptions {
  filesystem: WorkspaceFilesystemLike;
  publicOrigin: string;
  ttlSeconds: number;
  maxBytes: number;
  /** Directory prefix inside the workspace (default `transit`). */
  prefix?: string;
}

interface TransitFileMetadata {
  name: string;
  mimeType: string;
  createdAt: string;
  sizeBytes: number;
}

/**
 * Transit file storage backed by a Mastra-compatible workspace filesystem.
 */
export class WorkspaceTransitFileService implements ITransitFileService {
  private readonly filesystem: WorkspaceFilesystemLike;
  private readonly publicOrigin: string;
  private readonly ttlMs: number;
  private readonly prefix: string;
  readonly maxBytes: number;

  constructor(options: WorkspaceTransitFileOptions) {
    this.filesystem = options.filesystem;
    this.publicOrigin = options.publicOrigin.replace(/\/+$/, "");
    this.ttlMs = options.ttlSeconds * 1000;
    this.maxBytes = options.maxBytes;
    this.prefix = (options.prefix ?? "transit").replace(/^\/+|\/+$/g, "") || "transit";
  }

  async create(file: File): Promise<TransitFileUpload> {
    this.assertFileSize(file.size);
    const fileId = `${randomHex(16)}${safeExtension(file.name)}`;
    const metadata = normalizeMetadata({
      name: file.name || fileId,
      mimeType: file.type || contentTypeFromFileId(fileId),
      createdAt: new Date().toISOString(),
      sizeBytes: file.size,
    });

    const body = Buffer.from(await file.arrayBuffer());
    await this.filesystem.writeFile(this.objectPath(fileId), body, { recursive: true, overwrite: true });
    await this.filesystem.writeFile(this.metadataPath(fileId), JSON.stringify(metadata), {
      recursive: true,
      overwrite: true,
    });

    return {
      fileId,
      downloadUrl: `${this.publicOrigin}/api/files/${encodeURIComponent(fileId)}`,
      sizeBytes: metadata.sizeBytes,
      name: metadata.name,
      mimeType: metadata.mimeType,
    };
  }

  async read(fileId: string): Promise<TransitFileRead> {
    const { body, metadata } = await this.readObject(fileId);
    const bytes = new Uint8Array(body);
    return {
      file: new File([bytes], metadata.name, { type: metadata.mimeType }),
      sizeBytes: metadata.sizeBytes,
      name: metadata.name,
      mimeType: metadata.mimeType,
    };
  }

  async response(fileId: string): Promise<Response> {
    const { body, metadata } = await this.readObject(fileId);
    return new Response(new Uint8Array(body), {
      headers: {
        "content-length": String(metadata.sizeBytes),
        "content-type": metadata.mimeType,
        "content-disposition": contentDispositionForFileName(metadata.name),
      },
    });
  }

  async delete(fileId: string): Promise<boolean> {
    assertSafeFileId(fileId);
    const existed = await this.pathExists(this.objectPath(fileId));
    await this.filesystem.deleteFile(this.objectPath(fileId), { force: true });
    await this.filesystem.deleteFile(this.metadataPath(fileId), { force: true });
    return existed;
  }

  async cleanupExpired(): Promise<void> {}

  private async readObject(fileId: string): Promise<{ body: Buffer; metadata: TransitFileMetadata }> {
    assertSafeFileId(fileId);
    const metadata = await this.readMetadata(fileId);
    if (!metadata || this.isExpired(metadata)) {
      await this.delete(fileId);
      throw new TransitFileError(404, "file_not_found", "Transit file was not found.");
    }

    try {
      const content = await this.filesystem.readFile(this.objectPath(fileId), { encoding: "binary" });
      const body = typeof content === "string" ? Buffer.from(content, "binary") : Buffer.from(content);
      return { body, metadata };
    } catch {
      await this.delete(fileId);
      throw new TransitFileError(404, "file_not_found", "Transit file was not found.");
    }
  }

  private async readMetadata(fileId: string): Promise<TransitFileMetadata | undefined> {
    try {
      const raw = await this.filesystem.readFile(this.metadataPath(fileId), { encoding: "utf-8" });
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      return normalizeMetadata(JSON.parse(text) as Partial<TransitFileMetadata>);
    } catch {
      return undefined;
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    if (this.filesystem.exists) {
      return await this.filesystem.exists(path);
    }
    try {
      await this.filesystem.readFile(path, { encoding: "binary" });
      return true;
    } catch {
      return false;
    }
  }

  private objectPath(fileId: string): string {
    return `/${this.prefix}/${fileId}`;
  }

  private metadataPath(fileId: string): string {
    return `/${this.prefix}/${fileId}.meta.json`;
  }

  private isExpired(metadata: TransitFileMetadata): boolean {
    return Date.now() - Date.parse(metadata.createdAt) > this.ttlMs;
  }

  private assertFileSize(size: number): void {
    if (size > this.maxBytes) {
      throw new TransitFileError(413, "file_too_large", `Transit file must be ${this.maxBytes} bytes or smaller.`);
    }
  }
}

function normalizeMetadata(input: Partial<TransitFileMetadata>): TransitFileMetadata {
  return {
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : "file",
    mimeType:
      typeof input.mimeType === "string" && input.mimeType.trim() ? input.mimeType.trim() : "application/octet-stream",
    createdAt: typeof input.createdAt === "string" && input.createdAt ? input.createdAt : new Date().toISOString(),
    sizeBytes: typeof input.sizeBytes === "number" && Number.isFinite(input.sizeBytes) ? input.sizeBytes : 0,
  };
}

function assertSafeFileId(fileId: string): void {
  if (!/^[a-f0-9]{32}(?:\.[a-z0-9]{1,16})?$/.test(fileId)) {
    throw new TransitFileError(404, "file_not_found", "Transit file was not found.");
  }
}

function safeExtension(name: string): string {
  const extension = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : "";
}

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
