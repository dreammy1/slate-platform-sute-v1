# ADR 006: Media & File Storage Abstraction

## Status

Accepted

## Context

The platform requires a way to handle binary assets (documents, images, profile pictures). Hard-coding a specific storage provider (like AWS S3) creates vendor lock-in and makes local development cumbersome. We need a unified interface that handles uploads, retrievals, and security across different environments.

## Decision

We will implement a storage abstraction layer in `@slate/media` that follows the "Provider Pattern."

### 1. Provider Interface

The `MediaStorageProvider` interface will define:

- `upload(path: string, buffer: Buffer, mimeType: string): Promise<StorageMetadata>`
- `download(path: string): Promise<Buffer>`
- `delete(path: string): Promise<void>`
- `getSignedUrl(path: string, expiresIn: number): Promise<string>`
- `exists(path: string): Promise<boolean>`

### 2. Implementations

- **S3 Provider**: Primary production provider. Supports AWS S3, MinIO, and DigitalOcean Spaces (S3-compatible).
- **FileSystem Provider**: Local disk fallback for development and CI, ensuring no cloud dependency for basic tests.

### 3. Tenant-Bound Access Controls

To prevent cross-tenant data leakage (Broken Object Level Authorization), all storage paths will be prefixed with the `tenant_id`:
`storage/{tenant_id}/{category}/{file_id}`
The application layer will be responsible for verifying that the current user's `tenant_id` matches the path prefix before generating signed URLs or retrieving files.

### 4. Signed URLs

For security, files are never served directly via public URLs. The system will generate short-lived signed URLs (pre-signed) via the provider, ensuring that access is authenticated and time-bound.

### 5. Image Variant Processing

To optimize delivery, the media engine will support "Variants."

- The core engine stores the original.
- A processing pipeline (using `sharp`) will generate common thumbnails/resized versions on-demand or at upload time, stored under a `.variants/` prefix.

## Consequences

- **Pros**: Total vendor independence; secure tenant isolation; simplified local dev.
- **Cons**: Slight overhead in abstraction; requirement to manage signed URL expiration on the frontend.

## Validation

- Integration tests must verify that a file uploaded to `tenant-A` cannot be accessed via a signed URL generated for `tenant-B`.
- Local disk provider must be fully interchangeable with S3 provider via environment configuration.
