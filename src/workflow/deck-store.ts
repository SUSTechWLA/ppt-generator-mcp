import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  deckConsistencySchema,
  deckManifestSchema,
  deckPageRecordSchema,
  deckPersistedErrorStageSchema,
  type DeckManifest,
  type DeckPageError,
  type DeckPageRecord,
} from "../domain/deck-manifest.js";
import { generateDeckOutputSchema } from "../domain/deck-plan.js";
import { generateSlideOutputSchema, type GenerateSlideOutput } from "../domain/quality-report.js";
import { WorkflowError, type WorkflowErrorCode } from "../domain/workflow-error.js";

type GenerateDeckOutput = ReturnType<typeof generateDeckOutputSchema.parse>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSET_ID = /^(?:p\d+-)?(?:img|icon)-\d{3}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ARTIFACTS = new Set<DeckArtifactName>(["plan.json", "manifest.json", "consistency.json"]);
const MAX_JSON_ARTIFACT_BYTES = 512 * 1024;

type DeckArtifactName = "plan.json" | "manifest.json" | "consistency.json";

interface RequestIndexEntry {
  id: string;
  fingerprint: string;
}

type RequestIndex = Record<string, RequestIndexEntry>;

export interface DeckStoreApi {
  createOrResumePlan(input: { requestId?: string; canonicalInput: unknown }): Promise<{ deckPlanId: string; resumed: boolean; plan?: unknown }>;
  savePlan(deckPlanId: string, output: unknown): Promise<void>;
  getPlan(deckPlanId: string): Promise<unknown>;
  createOrResumeRun(input: {
    requestId?: string;
    canonicalInput: { deckPlanId: string };
    deckPlanId: string;
  }): Promise<{ deckRunId: string; resumed: boolean; manifest: DeckManifest }>;
  mergeAssetHashes(deckRunId: string, hashes: Record<string, string>): Promise<DeckManifest>;
  markNeedsAssets(deckRunId: string, ids: string[]): Promise<GenerateDeckOutput>;
  hasDeliveredPage(deckRunId: string, pageNumber: number): Promise<boolean>;
  savePageResult(deckRunId: string, pageNumber: number, result: GenerateSlideOutput): Promise<DeckManifest>;
  savePageFailure(deckRunId: string, pageNumber: number, error: unknown): Promise<DeckManifest>;
  listPageRecords(deckRunId: string): Promise<DeckPageRecord[]>;
  finalizeRun(deckRunId: string, input: {
    pages: DeckPageRecord[];
    consistency?: { passed: boolean; issues: string[] };
  }): Promise<GenerateDeckOutput>;
  getRun(deckRunId: string): Promise<DeckManifest>;
  getArtifact(id: string, name: DeckArtifactName): Promise<{ path: string; size: number; text?: string }>;
}

const mutationQueues = new Map<string, Promise<void>>();

async function withMutationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const current = previous.then(() => gate);
  mutationQueues.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationQueues.get(key) === current) mutationQueues.delete(key);
  }
}

function normalizedJson(value: unknown, stack = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalInput must contain only finite JSON numbers");
    return value;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error("canonicalInput must be JSON-serializable");
  }
  if (typeof value !== "object") throw new Error("canonicalInput must be JSON-serializable");
  if (stack.has(value)) throw new Error("canonicalInput must not contain cycles");
  stack.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalizedJson(item, stack));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonicalInput must contain only plain JSON objects");
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) output[key] = normalizedJson(item, stack);
    }
    return output;
  } finally {
    stack.delete(value);
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizedJson(value));
}

function canonicallyEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function requireUuid(value: string, kind: "deckPlanId" | "deckRunId"): void {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`Invalid ${kind}: expected UUID`);
}

function requireRequestId(value: string | undefined): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length < 1 || value.length > 128) throw new Error("Invalid requestId");
}

function requirePageNumber(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 9999) throw new Error("Invalid pageNumber");
}

function safeJson(value: unknown, label: string): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) throw new Error("not serializable");
    return `${serialized}\n`;
  } catch {
    throw new Error(`Invalid ${label}: value is not JSON-serializable`);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

const PERSISTED_ERROR_MESSAGES: Record<WorkflowErrorCode, DeckPageError["message"]> = {
  INPUT_INVALID: "Page input was invalid",
  CONFIG_MISSING: "Page generation configuration is unavailable",
  TEMPLATE_FAILED: "Page template processing failed",
  MODEL_FAILED: "Page content generation failed",
  ASSET_FAILED: "Page asset generation failed",
  RENDER_FAILED: "Page rendering failed",
  QUALITY_FAILED: "Page quality validation failed",
  INTERNAL_ERROR: "Page generation failed",
};

function pageError(error: unknown): DeckPageError {
  if (error instanceof WorkflowError && Object.hasOwn(PERSISTED_ERROR_MESSAGES, error.code)) {
    const parsedStage = deckPersistedErrorStageSchema.safeParse(error.stage);
    return {
      code: error.code,
      ...(parsedStage.success ? { stage: parsedStage.data } : {}),
      message: PERSISTED_ERROR_MESSAGES[error.code],
      retryable: error.retryable,
    };
  }
  return { code: "INTERNAL_ERROR", message: "Page generation failed", retryable: false };
}

function validateIndex(value: unknown, idKind: "deckPlanId" | "deckRunId"): RequestIndex {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid index");
  const result: RequestIndex = Object.create(null) as RequestIndex;
  for (const [requestId, rawEntry] of Object.entries(value)) {
    if (requestId.length < 1 || requestId.length > 128 || typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
      throw new Error("invalid index");
    }
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.id !== "string" || !UUID.test(entry.id) || typeof entry.fingerprint !== "string" || !SHA256.test(entry.fingerprint)) {
      throw new Error("invalid index");
    }
    result[requestId] = { id: entry.id, fingerprint: entry.fingerprint };
  }
  return result;
}

function insertPage(pages: DeckPageRecord[], record: DeckPageRecord): DeckPageRecord[] {
  return [...pages.filter((page) => page.pageNumber !== record.pageNumber), record]
    .sort((left, right) => left.pageNumber - right.pageNumber);
}

function applyPageMutation(manifest: DeckManifest, incoming: DeckPageRecord): DeckManifest {
  const existing = manifest.pages.find((page) => page.pageNumber === incoming.pageNumber);
  if (manifest.status === "delivered") {
    if (existing && canonicallyEqual(existing, incoming)) return manifest;
    throw new Error("Delivered deck run is immutable");
  }
  if (existing?.status === "delivered") {
    if (canonicallyEqual(existing, incoming)) return manifest;
    throw new Error(`Delivered page ${incoming.pageNumber} is immutable`);
  }
  if (existing && canonicallyEqual(existing, incoming)) return manifest;
  return { ...manifest, status: "running", pages: insertPage(manifest.pages, incoming) };
}

function outputPages(records: DeckPageRecord[]): GenerateDeckOutput["pages"] {
  const pages: GenerateDeckOutput["pages"] = [];
  for (const record of records) {
    if (record.result) pages.push({ ...record.result, pageNumber: record.pageNumber });
    else if (record.error) pages.push({
      pageNumber: record.pageNumber,
      status: "failed",
      error: { code: record.error.code, message: record.error.message, retryable: record.error.retryable },
    });
  }
  return pages;
}

export class DeckStore implements DeckStoreApi {
  readonly root: string;

  constructor(root: string) {
    if (typeof root !== "string" || root.trim().length === 0) throw new Error("Invalid deck output root");
    this.root = resolve(root);
  }

  private safePath(...segments: string[]): string {
    const target = resolve(this.root, ...segments);
    const delta = relative(this.root, target);
    if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
      throw new Error("Resolved path escapes the output root");
    }
    return target;
  }

  private async ensureLayout(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const directory of [
      this.safePath("decks"),
      this.safePath("decks", "plans"),
      this.safePath("decks", "runs"),
    ]) {
      await mkdir(directory, { recursive: true });
      await this.assertRealPathContained(directory);
    }
  }

  private async assertRealPathContained(path: string, allowMissing = false): Promise<void> {
    const actualRoot = await realpath(this.root);
    let actualTarget: string;
    try {
      actualTarget = await realpath(path);
    } catch (error) {
      if (!allowMissing || !isErrno(error, "ENOENT")) throw error;
      actualTarget = await realpath(dirname(path));
    }
    const delta = relative(actualRoot, actualTarget);
    if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
      throw new Error("Resolved path escapes the output root");
    }
  }

  private planDir(deckPlanId: string): string {
    requireUuid(deckPlanId, "deckPlanId");
    return this.safePath("decks", "plans", deckPlanId);
  }

  private runDir(deckRunId: string): string {
    requireUuid(deckRunId, "deckRunId");
    return this.safePath("decks", "runs", deckRunId);
  }

  private planPath(deckPlanId: string): string {
    return join(this.planDir(deckPlanId), "plan.json");
  }

  private manifestPath(deckRunId: string): string {
    return join(this.runDir(deckRunId), "manifest.json");
  }

  private consistencyPath(deckRunId: string): string {
    return join(this.runDir(deckRunId), "consistency.json");
  }

  private planIndexPath(): string {
    return this.safePath("decks", "plan-request-index.json");
  }

  private runIndexPath(): string {
    return this.safePath("decks", "run-request-index.json");
  }

  private async atomicWrite(path: string, value: string): Promise<void> {
    await this.assertRealPathContained(path, true);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, value, { flag: "wx" });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isErrno(error, "ENOENT")) throw error;
      });
    }
  }

  private async readJson(path: string, label: string, allowMissing = false): Promise<unknown | undefined> {
    try {
      await this.assertRealPathContained(path, allowMissing);
      const text = await readFile(path, "utf8");
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`Corrupted deck JSON (${label}): invalid JSON`);
      }
    } catch (error) {
      if (allowMissing && isErrno(error, "ENOENT")) return undefined;
      if (isErrno(error, "ENOENT")) throw new Error(`Deck JSON not found (${label})`);
      if (typeof error === "object" && error !== null && "code" in error) {
        throw new Error(`Unable to read deck JSON (${label}): filesystem error`);
      }
      throw error;
    }
  }

  private async readIndex(path: string, label: string, kind: "deckPlanId" | "deckRunId"): Promise<RequestIndex> {
    const raw = await this.readJson(path, label, true);
    if (raw === undefined) return Object.create(null) as RequestIndex;
    try {
      return validateIndex(raw, kind);
    } catch {
      throw new Error(`Corrupted deck JSON (${label}): invalid structure`);
    }
  }

  private async writeManifest(manifest: DeckManifest): Promise<DeckManifest> {
    const candidate = { ...manifest, updatedAt: new Date().toISOString() };
    const parsed = deckManifestSchema.safeParse(candidate);
    if (!parsed.success) throw new Error("Invalid deck manifest state");
    await this.atomicWrite(this.manifestPath(candidate.deckRunId), safeJson(parsed.data, "deck manifest"));
    return parsed.data;
  }

  private async mutateManifest(deckRunId: string, operation: (manifest: DeckManifest) => Promise<DeckManifest> | DeckManifest): Promise<DeckManifest> {
    requireUuid(deckRunId, "deckRunId");
    return withMutationLock(`${this.root}:run:${deckRunId}`, async () => {
      const manifest = await this.getRun(deckRunId);
      return this.writeManifest(await operation(manifest));
    });
  }

  private toOutput(manifest: DeckManifest): GenerateDeckOutput {
    return generateDeckOutputSchema.parse({
      deckRunId: manifest.deckRunId,
      deckPlanId: manifest.deckPlanId,
      status: manifest.status,
      pages: outputPages(manifest.pages),
      missingAssetIds: manifest.missingAssetIds,
      manifestPath: this.manifestPath(manifest.deckRunId),
      ...(manifest.consistency ? { consistency: manifest.consistency } : {}),
    });
  }

  async createOrResumePlan(input: { requestId?: string; canonicalInput: unknown }): Promise<{ deckPlanId: string; resumed: boolean; plan?: unknown }> {
    requireRequestId(input.requestId);
    const requestFingerprint = fingerprint(input.canonicalInput);
    await this.ensureLayout();
    return withMutationLock(`${this.root}:plan-index`, async () => {
      const indexPath = this.planIndexPath();
      const index = await this.readIndex(indexPath, "plan request index", "deckPlanId");
      if (input.requestId && Object.hasOwn(index, input.requestId)) {
        const entry = index[input.requestId];
        if (entry.fingerprint !== requestFingerprint) throw new Error(`requestId fingerprint mismatch for ${input.requestId}`);
        const plan = await this.readJson(this.planPath(entry.id), "plan.json", true);
        return { deckPlanId: entry.id, resumed: true, ...(plan !== undefined ? { plan } : {}) };
      }

      const deckPlanId = randomUUID();
      const directory = this.planDir(deckPlanId);
      await mkdir(directory);
      await this.assertRealPathContained(directory);
      if (input.requestId) {
        index[input.requestId] = { id: deckPlanId, fingerprint: requestFingerprint };
        await this.atomicWrite(indexPath, safeJson(index, "plan request index"));
      }
      return { deckPlanId, resumed: false };
    });
  }

  async savePlan(deckPlanId: string, output: unknown): Promise<void> {
    await this.ensureLayout();
    const directory = this.planDir(deckPlanId);
    return withMutationLock(`${this.root}:plan:${deckPlanId}`, async () => {
      try {
        const metadata = await stat(directory);
        if (!metadata.isDirectory()) throw new Error("not a directory");
        await this.assertRealPathContained(directory);
      } catch (error) {
        if (isErrno(error, "ENOENT")) throw new Error(`Unknown deckPlanId: ${deckPlanId}`);
        throw error;
      }
      const normalizedOutput = normalizedJson(output);
      const existing = await this.readJson(this.planPath(deckPlanId), "plan.json", true);
      if (existing !== undefined) {
        if (canonicallyEqual(existing, normalizedOutput)) return;
        throw new Error(`Deck plan replacement rejected for ${deckPlanId}`);
      }
      await this.atomicWrite(this.planPath(deckPlanId), safeJson(normalizedOutput, "deck plan"));
    });
  }

  async getPlan(deckPlanId: string): Promise<unknown> {
    await this.ensureLayout();
    const result = await this.readJson(this.planPath(deckPlanId), "plan.json");
    return result;
  }

  async createOrResumeRun(input: {
    requestId?: string;
    canonicalInput: { deckPlanId: string };
    deckPlanId: string;
  }): Promise<{ deckRunId: string; resumed: boolean; manifest: DeckManifest }> {
    requireRequestId(input.requestId);
    requireUuid(input.deckPlanId, "deckPlanId");
    if (!input.canonicalInput || input.canonicalInput.deckPlanId !== input.deckPlanId) throw new Error("canonicalInput deckPlanId mismatch");
    const requestFingerprint = fingerprint({ deckPlanId: input.deckPlanId });
    await this.ensureLayout();
    return withMutationLock(`${this.root}:run-index`, async () => {
      const indexPath = this.runIndexPath();
      const index = await this.readIndex(indexPath, "run request index", "deckRunId");
      if (input.requestId && Object.hasOwn(index, input.requestId)) {
        const entry = index[input.requestId];
        if (entry.fingerprint !== requestFingerprint) throw new Error(`requestId fingerprint mismatch for ${input.requestId}`);
        return { deckRunId: entry.id, resumed: true, manifest: await this.getRun(entry.id) };
      }

      const deckRunId = randomUUID();
      const now = new Date().toISOString();
      const directory = this.runDir(deckRunId);
      await mkdir(directory);
      await this.assertRealPathContained(directory);
      const manifest = await this.writeManifest({
        version: 1,
        deckRunId,
        deckPlanId: input.deckPlanId,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        requestFingerprint,
        status: "running",
        createdAt: now,
        updatedAt: now,
        assetHashes: {},
        missingAssetIds: [],
        pages: [],
      });
      if (input.requestId) {
        index[input.requestId] = { id: deckRunId, fingerprint: requestFingerprint };
        await this.atomicWrite(indexPath, safeJson(index, "run request index"));
      }
      return { deckRunId, resumed: false, manifest };
    });
  }

  async getRun(deckRunId: string): Promise<DeckManifest> {
    await this.ensureLayout();
    const raw = await this.readJson(this.manifestPath(deckRunId), "manifest.json");
    const parsed = deckManifestSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Corrupted deck JSON (manifest.json): invalid structure");
    return parsed.data;
  }

  async mergeAssetHashes(deckRunId: string, hashes: Record<string, string>): Promise<DeckManifest> {
    if (typeof hashes !== "object" || hashes === null || Array.isArray(hashes)) throw new Error("Invalid asset hashes");
    for (const [assetId, hash] of Object.entries(hashes)) {
      if (!ASSET_ID.test(assetId)) throw new Error(`Invalid asset id: ${assetId}`);
      if (!SHA256.test(hash)) throw new Error(`Invalid asset hash for ${assetId}`);
    }
    return this.mutateManifest(deckRunId, (manifest) => {
      if (manifest.status === "delivered") {
        const idempotent = Object.entries(hashes).every(([assetId, hash]) => manifest.assetHashes[assetId] === hash);
        if (idempotent) return manifest;
        throw new Error("Delivered deck run is immutable");
      }
      const assetHashes = { ...manifest.assetHashes };
      for (const [assetId, hash] of Object.entries(hashes)) {
        if (assetHashes[assetId] && assetHashes[assetId] !== hash) throw new Error(`Asset hash replacement rejected for ${assetId}`);
        assetHashes[assetId] = hash;
      }
      const missingAssetIds = manifest.missingAssetIds.filter((assetId) => !assetHashes[assetId]);
      return {
        ...manifest,
        assetHashes,
        missingAssetIds,
        status: manifest.status === "needs_assets" && missingAssetIds.length === 0 ? "running" : manifest.status,
      };
    });
  }

  async markNeedsAssets(deckRunId: string, ids: string[]): Promise<GenerateDeckOutput> {
    if (!Array.isArray(ids)) throw new Error("Invalid missing asset ids");
    for (const assetId of ids) if (!ASSET_ID.test(assetId)) throw new Error(`Invalid asset id: ${assetId}`);
    const manifest = await this.mutateManifest(deckRunId, (current) => {
      const missingAssetIds = Array.from(new Set([...current.missingAssetIds, ...ids]))
        .filter((assetId) => !current.assetHashes[assetId]);
      if (current.status === "delivered") {
        if (missingAssetIds.length === 0) return current;
        throw new Error("Delivered deck run is immutable");
      }
      return { ...current, missingAssetIds, status: missingAssetIds.length > 0 ? "needs_assets" : "running" };
    });
    return this.toOutput(manifest);
  }

  async hasDeliveredPage(deckRunId: string, pageNumber: number): Promise<boolean> {
    requirePageNumber(pageNumber);
    return (await this.getRun(deckRunId)).pages.some((page) => page.pageNumber === pageNumber && page.status === "delivered");
  }

  async savePageResult(deckRunId: string, pageNumber: number, result: GenerateSlideOutput): Promise<DeckManifest> {
    requirePageNumber(pageNumber);
    const parsed = generateSlideOutputSchema.safeParse(result);
    if (!parsed.success) throw new Error("Invalid generated page result");
    const record = deckPageRecordSchema.parse({
      pageNumber,
      status: parsed.data.status,
      runId: parsed.data.runId,
      result: parsed.data,
    });
    return this.mutateManifest(deckRunId, (manifest) => {
      if (manifest.missingAssetIds.length > 0) throw new Error("Cannot save a page while assets are missing");
      return applyPageMutation(manifest, record);
    });
  }

  async savePageFailure(deckRunId: string, pageNumber: number, error: unknown): Promise<DeckManifest> {
    requirePageNumber(pageNumber);
    const record = deckPageRecordSchema.parse({ pageNumber, status: "failed", error: pageError(error) });
    return this.mutateManifest(deckRunId, (manifest) => {
      if (manifest.missingAssetIds.length > 0) throw new Error("Cannot save a page while assets are missing");
      return applyPageMutation(manifest, record);
    });
  }

  async listPageRecords(deckRunId: string): Promise<DeckPageRecord[]> {
    return (await this.getRun(deckRunId)).pages.slice().sort((left, right) => left.pageNumber - right.pageNumber);
  }

  async finalizeRun(deckRunId: string, input: {
    pages: DeckPageRecord[];
    consistency?: { passed: boolean; issues: string[] };
  }): Promise<GenerateDeckOutput> {
    if (!Array.isArray(input.pages) || input.pages.length === 0) throw new Error("Cannot finalize a deck without page records");
    const pages = input.pages.map((page) => deckPageRecordSchema.parse(page));
    if (pages.some((page) => page.status === "running")) throw new Error("Cannot finalize while a page is running");
    if (new Set(pages.map((page) => page.pageNumber)).size !== pages.length) throw new Error("Cannot finalize duplicate page numbers");
    const consistency = input.consistency === undefined ? undefined : deckConsistencySchema.parse(input.consistency);

    const manifest = await this.mutateManifest(deckRunId, async (current) => {
      if (current.missingAssetIds.length > 0) throw new Error("Cannot finalize while assets are missing");
      for (const protectedPage of current.pages.filter((page) => page.status === "delivered")) {
        const incoming = pages.find((page) => page.pageNumber === protectedPage.pageNumber);
        if (!incoming) throw new Error(`Cannot omit delivered page ${protectedPage.pageNumber}`);
        if (!canonicallyEqual(protectedPage, incoming)) throw new Error(`Delivered page ${protectedPage.pageNumber} is immutable`);
      }
      if (current.status === "delivered") {
        const sortedInput = pages.slice().sort((left, right) => left.pageNumber - right.pageNumber);
        const effectiveConsistency = consistency ?? current.consistency;
        if (!canonicallyEqual(current.pages, sortedInput) || !canonicallyEqual(current.consistency ?? null, effectiveConsistency ?? null)) {
          throw new Error("Delivered deck run is immutable");
        }
        return current;
      }
      let merged = current.pages.slice();
      for (const page of pages) {
        merged = insertPage(merged, page);
      }
      merged = merged.sort((left, right) => left.pageNumber - right.pageNumber);
      const effectiveConsistency = consistency ?? current.consistency;
      const deliveredCount = merged.filter((page) => page.status === "delivered").length;
      const successfulCount = merged.filter((page) => page.status === "delivered" || page.status === "best_effort").length;
      const status = deliveredCount === merged.length && effectiveConsistency?.passed !== false
        ? "delivered"
        : successfulCount > 0
          ? "partial"
          : "failed";
      if (effectiveConsistency) await this.atomicWrite(this.consistencyPath(deckRunId), safeJson(effectiveConsistency, "deck consistency"));
      return { ...current, status, pages: merged, ...(effectiveConsistency ? { consistency: effectiveConsistency } : {}) };
    });
    return this.toOutput(manifest);
  }

  async getArtifact(id: string, name: DeckArtifactName): Promise<{ path: string; size: number; text?: string }> {
    if (!ARTIFACTS.has(name)) throw new Error(`Invalid deck artifact name: ${String(name)}`);
    requireUuid(id, name === "plan.json" ? "deckPlanId" : "deckRunId");
    try {
      await this.ensureLayout();
      const path = name === "plan.json"
        ? this.planPath(id)
        : name === "manifest.json"
          ? this.manifestPath(id)
          : this.consistencyPath(id);
      await this.assertRealPathContained(path);
      const metadata = await stat(path);
      if (!metadata.isFile()) throw new Error("Artifact is not a regular file");
      const result: { path: string; size: number; text?: string } = { path, size: metadata.size };
      if (metadata.size <= MAX_JSON_ARTIFACT_BYTES) result.text = await readFile(path, "utf8");
      return result;
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new Error(`Deck artifact not found (${name})`);
      if (error instanceof Error && error.message === "Resolved path escapes the output root") {
        throw new Error(`Deck artifact unavailable (${name}): unsafe path`);
      }
      throw new Error(`Unable to read deck artifact (${name}): filesystem error`);
    }
  }
}
