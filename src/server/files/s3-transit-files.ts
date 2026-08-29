import type { ITransitFileService, TransitFileRead, TransitFileUpload } from "./transit-file-store.ts";
import type { S3ClientConfig } from "@aws-sdk/client-s3";

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { extname } from "node:path";
import { contentDispositionForFileName, contentTypeFromFileId, TransitFileError } from "./transit-file-store.ts";

export interface S3TransitFileOptions {
  bucket: string;
  publicOrigin: string;
  ttlSeconds: number;
  maxBytes: number;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

interface TransitFileMetadata {
  name: string;
  mimeType: string;
  createdAt: string;
  sizeBytes: number;
}

/**
 * S3-compatible transit file storage (AWS S3, MinIO, etc.).
 */
export class S3TransitFileService implements ITransitFileService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicOrigin: string;
  private readonly ttlMs: number;
  readonly maxBytes: number;

  constructor(options: S3TransitFileOptions) {
    this.bucket = options.bucket;
    this.publicOrigin = options.publicOrigin.replace(/\/+$/, "");
    this.ttlMs = options.ttlSeconds * 1000;
    this.maxBytes = options.maxBytes;
    this.client = new S3Client(buildS3ClientConfig(options));
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

    const body = new Uint8Array(await file.arrayBuffer());
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey(fileId),
        Body: body,
        ContentType: metadata.mimeType,
      }),
    );
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: metadataKey(fileId),
        Body: JSON.stringify(metadata),
        ContentType: "application/json",
      }),
    );

    return {
      fileId,
      downloadUrl: `${this.publicOrigin}/api/files/${encodeURIComponent(fileId)}`,
      sizeBytes: metadata.sizeBytes,
      name: metadata.name,
      mimeType: metadata.mimeType,
    };
  }

  async read(fileId: string): Promise<TransitFileRead> {
    const { bytes, metadata } = await this.readObject(fileId);
    return {
      file: new File([toArrayBuffer(bytes)], metadata.name, { type: metadata.mimeType }),
      sizeBytes: metadata.sizeBytes,
      name: metadata.name,
      mimeType: metadata.mimeType,
    };
  }

  async response(fileId: string): Promise<Response> {
    const { bytes, metadata } = await this.readObject(fileId);
    return new Response(toArrayBuffer(bytes), {
      headers: {
        "content-length": String(metadata.sizeBytes),
        "content-type": metadata.mimeType,
        "content-disposition": contentDispositionForFileName(metadata.name),
      },
    });
  }

  async delete(fileId: string): Promise<boolean> {
    assertSafeFileId(fileId);
    const existing = await this.getObjectBytes(objectKey(fileId));
    await Promise.all([
      this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey(fileId) })),
      this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: metadataKey(fileId) })),
    ]);
    return existing != null;
  }

  async cleanupExpired(): Promise<void> {}

  private async readObject(fileId: string): Promise<{
    bytes: Uint8Array;
    metadata: TransitFileMetadata;
  }> {
    assertSafeFileId(fileId);
    const [bytes, metadata] = await Promise.all([this.getObjectBytes(objectKey(fileId)), this.readMetadata(fileId)]);
    if (!bytes || !metadata || this.isExpired(metadata)) {
      await this.delete(fileId);
      throw new TransitFileError(404, "file_not_found", "Transit file was not found.");
    }

    return { bytes, metadata };
  }

  private async readMetadata(fileId: string): Promise<TransitFileMetadata | undefined> {
    const bytes = await this.getObjectBytes(metadataKey(fileId));
    if (!bytes) {
      return undefined;
    }

    try {
      return normalizeMetadata(JSON.parse(new TextDecoder().decode(bytes)) as Partial<TransitFileMetadata>);
    } catch {
      return undefined;
    }
  }

  private async getObjectBytes(key: string): Promise<Uint8Array | undefined> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      if (!result.Body) {
        return undefined;
      }
      return await result.Body.transformToByteArray();
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private assertFileSize(size: number): void {
    if (size > this.maxBytes) {
      throw new TransitFileError(413, "file_too_large", `Transit file must be ${this.maxBytes} bytes or smaller.`);
    }
  }

  private isExpired(metadata: TransitFileMetadata): boolean {
    return Date.now() - Date.parse(metadata.createdAt) > this.ttlMs;
  }
}

function buildS3ClientConfig(options: S3TransitFileOptions): S3ClientConfig {
  const config: S3ClientConfig = {
    region: options.region ?? "us-east-1",
  };
  if (options.endpoint) {
    config.endpoint = options.endpoint;
  }
  if (options.forcePathStyle != null) {
    config.forcePathStyle = options.forcePathStyle;
  }
  if (options.accessKeyId && options.secretAccessKey) {
    config.credentials = {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    };
  }
  return config;
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

function objectKey(fileId: string): string {
  return `transit/${fileId}`;
}

function metadataKey(fileId: string): string {
  return `transit/${fileId}.meta.json`;
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  const code = "Code" in error ? String((error as { Code?: unknown }).Code) : "";
  const httpStatus =
    "$metadata" in error &&
    error.$metadata &&
    typeof error.$metadata === "object" &&
    "httpStatusCode" in error.$metadata
      ? Number((error.$metadata as { httpStatusCode?: unknown }).httpStatusCode)
      : undefined;
  return name === "NoSuchKey" || name === "NotFound" || code === "NoSuchKey" || httpStatus === 404;
}
