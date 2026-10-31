# Use private Cloudflare R2 storage for photos and exports

Use Cloudflare R2 Standard for retained photos, supporting attachments, and generated exports, with Vercel application hosting and Turso for structured records. The initial project is a personal, non-commercial pilot targeting an operating budget below $10/month. R2's S3-compatible interface, larger included storage allowance, and absence of direct egress charges outweigh the convenience of consolidating storage on Vercel Blob; Blob's Hobby limits can suspend access when exceeded.

Keep the bucket private. The application must verify collection membership and requested access before issuing short-lived upload or download authorization; possession of a record identifier is not authorization. Never expose storage credentials to clients. Storage pricing and operation allowances must be rechecked before deployment; this choice is not a guarantee that the entire service will be free.
