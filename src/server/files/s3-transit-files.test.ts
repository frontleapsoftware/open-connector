import { beforeEach, describe, expect, it, vi } from "vitest";
import { TransitFileError } from "./transit-file-store.ts";

const objects = new Map<string, { body: Uint8Array; contentType?: string }>();

vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    input: { Bucket?: string; Key?: string; Body?: Uint8Array | string; ContentType?: string };

    constructor(input: { Bucket?: string; Key?: string; Body?: Uint8Array | string; ContentType?: string }) {
      this.input = input;
    }
  }

  class GetObjectCommand {
    input: { Bucket?: string; Key?: string };

    constructor(input: { Bucket?: string; Key?: string }) {
      this.input = input;
    }
  }

  class DeleteObjectCommand {
    input: { Bucket?: string; Key?: string };

    constructor(input: { Bucket?: string; Key?: string }) {
      this.input = input;
    }
  }

  class S3Client {
    async send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand): Promise<unknown> {
      if (command instanceof PutObjectCommand) {
        const key = command.input.Key ?? "";
        const body =
          typeof command.input.Body === "string"
            ? new TextEncoder().encode(command.input.Body)
            : (command.input.Body ?? new Uint8Array());
        objects.set(`${command.input.Bucket}:${key}`, {
          body: body instanceof Uint8Array ? body : new Uint8Array(body),
          contentType: command.input.ContentType,
        });
        return {};
      }

      if (command instanceof GetObjectCommand) {
        const entry = objects.get(`${command.input.Bucket}:${command.input.Key}`);
        if (!entry) {
          const error = Object.assign(new Error("NoSuchKey"), {
            name: "NoSuchKey",
            $metadata: { httpStatusCode: 404 },
          });
          throw error;
        }
        return {
          Body: {
            async transformToByteArray(): Promise<Uint8Array> {
              return entry.body.slice(0);
            },
          },
        };
      }

      if (command instanceof DeleteObjectCommand) {
        objects.delete(`${command.input.Bucket}:${command.input.Key}`);
        return {};
      }

      return {};
    }
  }

  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

const { S3TransitFileService } = await import("./s3-transit-files.ts");

describe("S3TransitFileService", () => {
  beforeEach(() => {
    objects.clear();
  });

  it("uploads, reads, and deletes transit files", async () => {
    const service = createService();

    const upload = await service.create(new File(["hello transit"], "report.TXT", { type: "text/plain" }));
    expect(upload.fileId).toMatch(/^[a-f0-9]{32}\.txt$/);
    expect(upload.downloadUrl).toBe(`http://localhost:3000/api/files/${upload.fileId}`);
    expect(upload).toMatchObject({
      sizeBytes: 13,
      name: "report.TXT",
      mimeType: "text/plain",
    });

    const read = await service.read(upload.fileId);
    expect(read).toMatchObject({
      sizeBytes: 13,
      name: "report.TXT",
      mimeType: "text/plain",
    });
    await expect(read.file.text()).resolves.toBe("hello transit");

    const response = await service.response(upload.fileId);
    expect(response.headers.get("content-type")).toBe("text/plain");
    await expect(response.text()).resolves.toBe("hello transit");

    await expect(service.delete(upload.fileId)).resolves.toBe(true);
    await expect(service.delete(upload.fileId)).resolves.toBe(false);
    await expect(service.read(upload.fileId)).rejects.toMatchObject({ status: 404, code: "file_not_found" });
  });

  it("rejects files over the configured limit", async () => {
    const service = createService({ maxBytes: 4 });

    await expect(service.create(new File(["12345"], "large.bin"))).rejects.toMatchObject({
      status: 413,
      code: "file_too_large",
    });
  });

  it("treats expired files as not found", async () => {
    const service = createService({ ttlSeconds: -1 });
    const upload = await service.create(new File(["old"], "old.txt"));

    await expect(service.read(upload.fileId)).rejects.toBeInstanceOf(TransitFileError);
    await expect(service.read(upload.fileId)).rejects.toMatchObject({ status: 404 });
  });

  it("treats malformed metadata as not found", async () => {
    const service = createService();
    const upload = await service.create(new File(["broken"], "broken.txt"));
    objects.set(`transit-files:transit/${upload.fileId}.meta.json`, {
      body: new TextEncoder().encode("{"),
    });

    await expect(service.read(upload.fileId)).rejects.toMatchObject({ status: 404 });
  });

  it("cleanupExpired is a no-op", async () => {
    const service = createService();
    await expect(service.cleanupExpired()).resolves.toBeUndefined();
  });
});

function createService(
  options: { ttlSeconds?: number; maxBytes?: number } = {},
): InstanceType<typeof S3TransitFileService> {
  return new S3TransitFileService({
    bucket: "transit-files",
    publicOrigin: "http://localhost:3000",
    ttlSeconds: options.ttlSeconds ?? 60,
    maxBytes: options.maxBytes ?? 1024 * 1024,
    region: "us-east-1",
    endpoint: "http://127.0.0.1:9000",
    accessKeyId: "minio",
    secretAccessKey: "minio123",
    forcePathStyle: true,
  });
}
