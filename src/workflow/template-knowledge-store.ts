import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import * as z from "zod/v4";

import { templateBlueprintSchema, type TemplateBlueprint } from "../domain/template-blueprint.js";
import { templateProfileSchema, type TemplateProfile } from "../domain/template-profile.js";

export const templateKnowledgeArtifactSchema = z.enum(["blueprint.json", "template.html", "profile.json", "qa.json", "preview.png"]);
export type TemplateKnowledgeArtifact = z.infer<typeof templateKnowledgeArtifactSchema>;

const qualityEvidenceBaseSchema = z.object({
  chromiumRendered: z.literal(true),
  hardGatePassed: z.literal(true),
  safeToReturn: z.literal(true),
  score: z.number().min(0).max(100),
  issues: z.array(z.object({ severity: z.string(), category: z.string(), evidence: z.string() }).strict()).max(50),
}).strict();

const legacyQualityEvidenceSchema = qualityEvidenceBaseSchema.extend({
  evidenceVersion: z.literal(1),
  imageEvidenceStatus: z.literal("not-recorded"),
}).strict();

const currentQualityEvidenceSchema = qualityEvidenceBaseSchema.extend({
  evidenceVersion: z.literal(2),
  imageEvidenceStatus: z.literal("measured"),
  imageCount: z.number().int().min(0).max(12),
  rasterAreaRatio: z.number().min(0).max(1),
  containmentViolations: z.literal(0),
  collisions: z.literal(0),
}).strict();
export type CurrentTemplateQualityEvidence = z.infer<typeof currentQualityEvidenceSchema>;

const qualityEvidenceSchema = z.discriminatedUnion("evidenceVersion", [legacyQualityEvidenceSchema, currentQualityEvidenceSchema]);
const rawLegacyQualityEvidenceSchema = qualityEvidenceBaseSchema;
const rawTransitionalQualityEvidenceSchema = qualityEvidenceBaseSchema.extend({
  imageCount: z.number().int().min(0).max(12),
  rasterAreaRatio: z.number().min(0).max(1),
  containmentViolations: z.literal(0),
  collisions: z.literal(0),
}).strict();

export const templateKnowledgeRecordSchema = z.object({
  recordVersion: z.literal(1),
  knowledgeId: z.string().uuid(),
  templateVersion: z.number().int().positive(),
  sourceType: z.enum(["html", "image", "blueprint"]),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  capabilityTags: z.array(z.string().min(1).max(40)).min(1).max(12),
  quality: qualityEvidenceSchema,
  artifacts: z.array(templateKnowledgeArtifactSchema).length(5),
  createdAt: z.string().datetime(),
}).strict();

export type TemplateKnowledgeRecord = z.infer<typeof templateKnowledgeRecordSchema>;

interface InternalRecord extends TemplateKnowledgeRecord {
  requestId?: string;
  requestFingerprint: string;
}

const internalRecordSchema = templateKnowledgeRecordSchema.extend({
  requestId: z.string().min(8).max(128).optional(),
  requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const rawInternalRecordSchema = templateKnowledgeRecordSchema.omit({ quality: true }).extend({
  quality: z.unknown(),
  requestId: z.string().min(8).max(128).optional(),
  requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

function normalizeQualityEvidence(raw: unknown): TemplateKnowledgeRecord["quality"] {
  const normalizedLegacy = legacyQualityEvidenceSchema.safeParse(raw);
  if (normalizedLegacy.success) return normalizedLegacy.data;
  const current = currentQualityEvidenceSchema.safeParse(raw);
  if (current.success) return current.data;
  const transitional = rawTransitionalQualityEvidenceSchema.safeParse(raw);
  if (transitional.success) return currentQualityEvidenceSchema.parse({
    ...transitional.data,
    evidenceVersion: 2,
    imageEvidenceStatus: "measured",
  });
  const legacy = rawLegacyQualityEvidenceSchema.safeParse(raw);
  if (legacy.success) return legacyQualityEvidenceSchema.parse({
    ...legacy.data,
    evidenceVersion: 1,
    imageEvidenceStatus: "not-recorded",
  });
  throw new Error("Invalid template quality evidence");
}

function normalizeInternalRecord(raw: unknown): InternalRecord {
  const parsed = rawInternalRecordSchema.parse(raw);
  return internalRecordSchema.parse({ ...parsed, quality: normalizeQualityEvidence(parsed.quality) });
}

function publicRecord(record: InternalRecord): TemplateKnowledgeRecord {
  const { requestId: _requestId, requestFingerprint: _requestFingerprint, ...value } = record;
  return templateKnowledgeRecordSchema.parse(value);
}

interface StoreIndex {
  version: 2;
  records: InternalRecord[];
  requests: Record<string,
    | { fingerprint: string; status: "analysis" }
    | { fingerprint: string; status: "approved"; knowledgeId: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 12 * 1024 * 1024;
const ROOT_MUTATION_LOCKS = new Map<string, Promise<void>>();

async function withRootMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = ROOT_MUTATION_LOCKS.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  const chain = previous.then(() => current);
  ROOT_MUTATION_LOCKS.set(root, chain);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (ROOT_MUTATION_LOCKS.get(root) === chain) ROOT_MUTATION_LOCKS.delete(root);
  }
}

function contained(root: string, target: string): boolean {
  const delta = relative(root, target);
  return delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
}

export interface TemplateKnowledgeStoreIo {
  writeFile(path: string, value: string | Buffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface TemplateKnowledgeApprovalInput {
  requestId?: string;
  requestFingerprint: string;
  sourceType: "html" | "image" | "blueprint";
  sourceHash: string;
  blueprint: TemplateBlueprint;
  html: string;
  profile: TemplateProfile;
  quality: CurrentTemplateQualityEvidence;
  preview: Buffer;
}

interface PreparedApproval extends Omit<TemplateKnowledgeApprovalInput, "blueprint" | "profile" | "quality" | "preview"> {
  blueprint: TemplateBlueprint;
  profile: TemplateProfile;
  quality: CurrentTemplateQualityEvidence;
  artifacts: Record<TemplateKnowledgeArtifact, Buffer>;
}

const approvalMetadataSchema = z.object({
  requestId: z.string().min(8).max(128).optional(),
  requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  sourceType: z.enum(["html", "image", "blueprint"]),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

function prepareApproval(input: TemplateKnowledgeApprovalInput): PreparedApproval {
  const metadata = approvalMetadataSchema.parse({
    requestId: input.requestId,
    requestFingerprint: input.requestFingerprint,
    sourceType: input.sourceType,
    sourceHash: input.sourceHash,
  });
  const blueprint = templateBlueprintSchema.parse(input.blueprint);
  const profile = templateProfileSchema.parse(input.profile);
  const quality = currentQualityEvidenceSchema.parse(input.quality);
  if (typeof input.html !== "string" || Buffer.byteLength(input.html) > MAX_TEXT_ARTIFACT_BYTES) {
    throw new Error("Compiled template HTML exceeds the bounded artifact limit");
  }
  if (!Buffer.isBuffer(input.preview) || input.preview.byteLength <= 0 || input.preview.byteLength > MAX_PREVIEW_BYTES) {
    throw new Error("Template preview exceeds the bounded artifact limit");
  }
  const artifacts: PreparedApproval["artifacts"] = {
    "blueprint.json": Buffer.from(`${JSON.stringify(blueprint, null, 2)}\n`),
    "template.html": Buffer.from(input.html),
    "profile.json": Buffer.from(`${JSON.stringify(profile, null, 2)}\n`),
    "qa.json": Buffer.from(`${JSON.stringify(quality, null, 2)}\n`),
    "preview.png": Buffer.from(input.preview),
  };
  return { ...metadata, html: input.html, blueprint, profile, quality, artifacts };
}

export class TemplateKnowledgeStore {
  readonly root: string;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #io: TemplateKnowledgeStoreIo;

  constructor(root: string, io: Partial<TemplateKnowledgeStoreIo> = {}) {
    this.root = resolve(root);
    this.#io = { writeFile: io.writeFile ?? writeFile, rename: io.rename ?? rename };
  }

  private async atomicWrite(path: string, value: string | Buffer): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await this.#io.writeFile(temporary, value);
      await this.#io.rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async withRequestLock<T>(requestId: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (!requestId) return operation();
    const previous = this.#locks.get(requestId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => { release = resolveLock; });
    const chain = previous.then(() => current);
    this.#locks.set(requestId, chain);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(requestId) === chain) this.#locks.delete(requestId);
    }
  }

  private indexPath(): string {
    return join(this.root, "knowledge-index.json");
  }

  private async ensureOwnedRoot(): Promise<void> {
    try {
      const entry = await lstat(this.root);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("unsafe");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Template knowledge storage is unsafe or unavailable");
      }
      await mkdir(this.root, { recursive: true });
      const created = await lstat(this.root);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error("Template knowledge storage is unsafe or unavailable");
      }
    }
  }

  private async readVerifiedIndexText(path: string): Promise<string | undefined> {
    try {
      const rootEntry = await lstat(this.root);
      if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw new Error("unsafe");
      let indexEntry;
      try {
        indexEntry = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      if (indexEntry.isSymbolicLink() || !indexEntry.isFile() || indexEntry.size > MAX_TEXT_ARTIFACT_BYTES) throw new Error("unsafe");
      const [actualRoot, actualPath] = await Promise.all([realpath(this.root), realpath(path)]);
      if (!contained(actualRoot, actualPath)) throw new Error("unsafe");
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Template knowledge storage is unsafe or unavailable");
    }
  }

  private async assertOwnedRecordsDirectory(path: string): Promise<void> {
    try {
      const recordsRoot = join(this.root, "records");
      const [rootEntry, recordsEntry, pathEntry] = await Promise.all([lstat(this.root), lstat(recordsRoot), lstat(path)]);
      if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()
        || recordsEntry.isSymbolicLink() || !recordsEntry.isDirectory()
        || pathEntry.isSymbolicLink() || !pathEntry.isDirectory()) throw new Error("unsafe");
      const [actualRoot, actualRecords, actualPath] = await Promise.all([realpath(this.root), realpath(recordsRoot), realpath(path)]);
      if (!contained(actualRoot, actualRecords) || !contained(actualRecords, actualPath)) throw new Error("unsafe");
    } catch {
      throw new Error("Template knowledge storage is unsafe or unavailable");
    }
  }

  async reserveAnalysisRequest(requestId: string | undefined, fingerprint: string): Promise<TemplateKnowledgeRecord | undefined> {
    if (!requestId) return;
    return withRootMutation(this.root, async () => {
      await this.ensureOwnedRoot();
      const index = await this.readIndex();
      const existing = Object.prototype.hasOwnProperty.call(index.requests, requestId) ? index.requests[requestId] : undefined;
      if (existing && existing.fingerprint !== fingerprint) throw new Error(`requestId fingerprint mismatch for ${requestId}`);
      if (existing?.status === "approved") {
        const record = index.records.find((candidate) => candidate.knowledgeId === existing.knowledgeId);
        if (!record) throw new Error("Template knowledge request index is corrupt");
        return publicRecord(record);
      }
      if (!existing) {
        Object.defineProperty(index.requests, requestId, {
          value: { fingerprint, status: "analysis" }, enumerable: true, writable: true, configurable: true,
        });
        await this.atomicWrite(this.indexPath(), `${JSON.stringify(index, null, 2)}\n`);
      }
      return undefined;
    });
  }

  private async readIndex(): Promise<StoreIndex> {
    try {
      const text = await this.readVerifiedIndexText(this.indexPath());
      const records: InternalRecord[] = [];
      const requests: StoreIndex["requests"] = Object.create(null) as StoreIndex["requests"];
      if (text !== undefined) {
        const raw = JSON.parse(text) as { version?: unknown; records?: unknown; requests?: unknown };
        if ((raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.records)
          || !raw.requests || typeof raw.requests !== "object" || Array.isArray(raw.requests)) throw new Error();
        records.push(...raw.records.map(normalizeInternalRecord));
        for (const [requestId, value] of Object.entries(raw.requests)) {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
          const entry = value as Record<string, unknown>;
          if (typeof entry.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(entry.fingerprint)) throw new Error();
          if (entry.status === "analysis" && entry.knowledgeId === undefined) {
            requests[requestId] = { fingerprint: entry.fingerprint, status: "analysis" };
          } else if ((entry.status === "approved" || entry.status === undefined) && typeof entry.knowledgeId === "string" && UUID.test(entry.knowledgeId)) {
            if (!records.some((record) => record.knowledgeId === entry.knowledgeId)) throw new Error();
            requests[requestId] = { fingerprint: entry.fingerprint, status: "approved", knowledgeId: entry.knowledgeId };
          } else throw new Error();
        }
      }
      const legacyAnalysisText = await this.readVerifiedIndexText(join(this.root, "analysis-request-index.json"));
      if (legacyAnalysisText !== undefined) {
        const legacy = JSON.parse(legacyAnalysisText) as unknown;
        if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) throw new Error();
        for (const [requestId, fingerprint] of Object.entries(legacy)) {
          if (requestId.length < 8 || requestId.length > 128 || typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error();
          const existing = requests[requestId];
          if (existing && existing.fingerprint !== fingerprint) throw new Error();
          if (!existing) requests[requestId] = { fingerprint, status: "analysis" };
        }
      }
      return { version: 2, records, requests };
    } catch (error) {
      throw new Error("Template knowledge index is unavailable or corrupt");
    }
  }

  async findRequest(requestId: string | undefined, fingerprint: string): Promise<TemplateKnowledgeRecord | undefined> {
    if (!requestId) return undefined;
    const index = await this.readIndex();
    const entry = Object.prototype.hasOwnProperty.call(index.requests, requestId) ? index.requests[requestId] : undefined;
    if (!entry) return undefined;
    if (entry.fingerprint !== fingerprint) throw new Error(`requestId fingerprint mismatch for ${requestId}`);
    if (entry.status === "analysis") return undefined;
    const record = index.records.find((candidate) => candidate.knowledgeId === entry.knowledgeId);
    if (!record) throw new Error("Template knowledge request index is corrupt");
    return publicRecord(record);
  }

  async approve(rawInput: TemplateKnowledgeApprovalInput): Promise<TemplateKnowledgeRecord> {
    const input = prepareApproval(rawInput);
    return withRootMutation(this.root, async () => {
      await this.ensureOwnedRoot();
      const index = await this.readIndex();
      if (input.requestId && Object.prototype.hasOwnProperty.call(index.requests, input.requestId)) {
        const existing = index.requests[input.requestId];
        if (existing.fingerprint !== input.requestFingerprint) throw new Error(`requestId fingerprint mismatch for ${input.requestId}`);
        if (existing.status === "approved") {
          const record = index.records.find((candidate) => candidate.knowledgeId === existing.knowledgeId);
          if (!record) throw new Error("Template knowledge request index is corrupt");
          return publicRecord(record);
        }
      }
      const recordsRoot = join(this.root, "records");
      await mkdir(recordsRoot, { recursive: true });
      await this.assertOwnedRecordsDirectory(recordsRoot);
      const knowledgeId = randomUUID();
      const recordDir = join(recordsRoot, knowledgeId);
      await mkdir(recordDir, { recursive: false });
      await this.assertOwnedRecordsDirectory(recordDir);
      const now = new Date().toISOString();
      const templateVersion = 1 + Math.max(0, ...index.records.filter((record) => record.slug === input.profile.slug).map((record) => record.templateVersion));
      const record: InternalRecord = {
      recordVersion: 1,
      knowledgeId,
      templateVersion,
      sourceType: input.sourceType,
      sourceHash: input.sourceHash,
      slug: input.profile.slug,
      capabilityTags: [...input.blueprint.capabilityTags],
      quality: input.quality,
      artifacts: ["blueprint.json", "template.html", "profile.json", "qa.json", "preview.png"],
      createdAt: now,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      requestFingerprint: input.requestFingerprint,
      };
      try {
        const writes = await Promise.allSettled(Object.entries(input.artifacts).map(([artifact, value]) => (
          this.atomicWrite(join(recordDir, artifact), value)
        )));
        const failed = writes.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) throw failed.reason;
        index.records.push(record);
        if (input.requestId) {
          Object.defineProperty(index.requests, input.requestId, {
            value: { fingerprint: input.requestFingerprint, status: "approved", knowledgeId }, enumerable: true, writable: true, configurable: true,
          });
        }
        await this.atomicWrite(this.indexPath(), `${JSON.stringify(index, null, 2)}\n`);
        return publicRecord(record);
      } catch (error) {
        await rm(recordDir, { recursive: true, force: true });
        if (index.records.length === 0) {
          try {
            await rmdir(recordsRoot);
          } catch (cleanupError) {
            const code = (cleanupError as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTEMPTY") throw cleanupError;
          }
        }
        throw error;
      }
    });
  }

  async list(): Promise<TemplateKnowledgeRecord[]> {
    const index = await this.readIndex();
    return index.records.map(publicRecord);
  }

  async getArtifact(knowledgeId: string, artifactName: TemplateKnowledgeArtifact): Promise<{ artifact: TemplateKnowledgeArtifact; size: number; text: string }> {
    if (!UUID.test(knowledgeId)) throw new Error("Template knowledge record not found");
    const parsedArtifact = templateKnowledgeArtifactSchema.safeParse(artifactName);
    if (!parsedArtifact.success) throw new Error("Invalid artifact name");
    const index = await this.readIndex();
    if (!index.records.some((record) => record.knowledgeId === knowledgeId)) throw new Error("Template knowledge record not found");
    const recordsRoot = join(this.root, "records");
    const recordDir = join(recordsRoot, knowledgeId);
    const path = join(recordDir, artifactName);
    try {
      const [rootEntry, recordsEntry, recordEntry, artifactEntry] = await Promise.all([
        lstat(this.root), lstat(recordsRoot), lstat(recordDir), lstat(path),
      ]);
      if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()
        || recordsEntry.isSymbolicLink() || !recordsEntry.isDirectory()
        || recordEntry.isSymbolicLink() || !recordEntry.isDirectory()
        || artifactEntry.isSymbolicLink() || !artifactEntry.isFile()) throw new Error("unsafe");
      const [actualRoot, actualRecords, actualRecord, actualPath] = await Promise.all([
        realpath(this.root), realpath(recordsRoot), realpath(recordDir), realpath(path),
      ]);
      if (!contained(actualRoot, actualRecords) || !contained(actualRecords, actualRecord) || !contained(actualRecord, actualPath)) throw new Error("unsafe");
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > MAX_TEXT_ARTIFACT_BYTES || artifactName === "preview.png") throw new Error("unsafe");
      return { artifact: artifactName, size: metadata.size, text: await readFile(path, "utf8") };
    } catch {
      throw new Error(`Artifact unavailable (${artifactName}): unsafe storage entry`);
    }
  }
}
