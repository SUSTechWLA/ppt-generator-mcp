import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import * as z from "zod/v4";

import { templateBlueprintSchema, type TemplateBlueprint } from "../domain/template-blueprint.js";
import { templateProfileSchema, type TemplateProfile } from "../domain/template-profile.js";

export const templateKnowledgeArtifactSchema = z.enum(["blueprint.json", "template.html", "profile.json", "qa.json", "preview.png"]);
export type TemplateKnowledgeArtifact = z.infer<typeof templateKnowledgeArtifactSchema>;

const qualityEvidenceSchema = z.object({
  chromiumRendered: z.literal(true),
  hardGatePassed: z.literal(true),
  safeToReturn: z.literal(true),
  score: z.number().min(0).max(100),
  issues: z.array(z.object({ severity: z.string(), category: z.string(), evidence: z.string() }).strict()).max(50),
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

function publicRecord(record: InternalRecord): TemplateKnowledgeRecord {
  const { requestId: _requestId, requestFingerprint: _requestFingerprint, ...value } = record;
  return templateKnowledgeRecordSchema.parse(value);
}

interface StoreIndex {
  version: 1;
  records: InternalRecord[];
  requests: Record<string, { fingerprint: string; knowledgeId: string }>;
}

type AnalysisRequestIndex = Record<string, string>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT_ARTIFACT_BYTES = 2 * 1024 * 1024;

function contained(root: string, target: string): boolean {
  const delta = relative(root, target);
  return delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
}

async function atomicWrite(path: string, value: string | Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, path);
}

export class TemplateKnowledgeStore {
  readonly root: string;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = resolve(root);
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

  async reserveAnalysisRequest(requestId: string | undefined, fingerprint: string): Promise<void> {
    if (!requestId) return;
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, "analysis-request-index.json");
    let index: AnalysisRequestIndex;
    try {
      const text = await this.readVerifiedIndexText(path);
      if (text === undefined) index = {};
      else index = JSON.parse(text) as AnalysisRequestIndex;
      if (!index || typeof index !== "object" || Array.isArray(index)
        || Object.values(index).some((value) => typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))) throw new Error();
    } catch (error) {
      throw new Error("Template analysis request index is unavailable or corrupt");
    }
    const existing = Object.prototype.hasOwnProperty.call(index, requestId) ? index[requestId] : undefined;
    if (existing && existing !== fingerprint) throw new Error(`requestId fingerprint mismatch for ${requestId}`);
    if (!existing) {
      Object.defineProperty(index, requestId, { value: fingerprint, enumerable: true, writable: true, configurable: true });
      await atomicWrite(path, `${JSON.stringify(index, null, 2)}\n`);
    }
  }

  private async readIndex(): Promise<StoreIndex> {
    try {
      const text = await this.readVerifiedIndexText(this.indexPath());
      if (text === undefined) return { version: 1, records: [], requests: {} };
      const raw = JSON.parse(text) as StoreIndex;
      if (raw.version !== 1 || !Array.isArray(raw.records) || !raw.requests || typeof raw.requests !== "object" || Array.isArray(raw.requests)
        || Object.values(raw.requests).some((entry) => !entry || typeof entry !== "object"
          || !/^[0-9a-f]{64}$/.test(entry.fingerprint) || !UUID.test(entry.knowledgeId))) throw new Error();
      for (const record of raw.records) internalRecordSchema.parse(record);
      return raw;
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
    const record = index.records.find((candidate) => candidate.knowledgeId === entry.knowledgeId);
    if (!record) throw new Error("Template knowledge request index is corrupt");
    return publicRecord(record);
  }

  async approve(input: {
    requestId?: string;
    requestFingerprint: string;
    sourceType: "html" | "image" | "blueprint";
    sourceHash: string;
    blueprint: TemplateBlueprint;
    html: string;
    profile: TemplateProfile;
    quality: TemplateKnowledgeRecord["quality"];
    preview: Buffer;
  }): Promise<TemplateKnowledgeRecord> {
    const recordsRoot = join(this.root, "records");
    await mkdir(recordsRoot, { recursive: true });
    await this.assertOwnedRecordsDirectory(recordsRoot);
    const index = await this.readIndex();
    if (input.requestId && Object.prototype.hasOwnProperty.call(index.requests, input.requestId)) {
      const existing = await this.findRequest(input.requestId, input.requestFingerprint);
      if (!existing) throw new Error("Template knowledge request index is corrupt");
      return existing;
    }
    const knowledgeId = randomUUID();
    const recordDir = join(this.root, "records", knowledgeId);
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
    await Promise.all([
      atomicWrite(join(recordDir, "blueprint.json"), `${JSON.stringify(templateBlueprintSchema.parse(input.blueprint), null, 2)}\n`),
      atomicWrite(join(recordDir, "template.html"), input.html),
      atomicWrite(join(recordDir, "profile.json"), `${JSON.stringify(templateProfileSchema.parse(input.profile), null, 2)}\n`),
      atomicWrite(join(recordDir, "qa.json"), `${JSON.stringify(input.quality, null, 2)}\n`),
      atomicWrite(join(recordDir, "preview.png"), input.preview),
    ]);
    index.records.push(record);
    if (input.requestId) {
      Object.defineProperty(index.requests, input.requestId, {
        value: { fingerprint: input.requestFingerprint, knowledgeId }, enumerable: true, writable: true, configurable: true,
      });
    }
    await atomicWrite(this.indexPath(), `${JSON.stringify(index, null, 2)}\n`);
    return publicRecord(record);
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
