import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { hashCanonical } from "../domain/source-document.js";
import type { ArtifactName, AttemptRecord, RunManifest, StageRecord, WorkflowStage } from "../domain/run-manifest.js";

interface RequestIndexEntry {
  runId: string;
  fingerprint: string;
}

type RequestIndex = Record<string, RequestIndexEntry>;

export interface ActiveRun {
  runId: string;
  manifest: RunManifest;
  resumed: boolean;
  store: RunStore;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARTIFACTS = new Set<ArtifactName>(["manifest.json", "final.html", "final.png", "quality.json"]);

async function atomicWrite(path: string, value: string | Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, path);
}

async function readJson<T>(path: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (fallback !== undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export class RunStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  runDir(runId: string): string {
    if (!RUN_ID.test(runId)) throw new Error(`Invalid runId: ${runId}`);
    return this.safePath(runId);
  }

  private safePath(...segments: string[]): string {
    const target = resolve(this.root, ...segments);
    const delta = relative(this.root, target);
    if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error("Resolved path escapes the output root");
    return target;
  }

  private manifestPath(runId: string): string {
    return join(this.runDir(runId), "manifest.json");
  }

  private async writeManifest(manifest: RunManifest): Promise<RunManifest> {
    manifest.updatedAt = new Date().toISOString();
    await atomicWrite(this.manifestPath(manifest.runId), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  async createOrResume(input: { requestId?: string; canonicalInput: unknown }): Promise<ActiveRun> {
    await mkdir(this.root, { recursive: true });
    const fingerprint = hashCanonical(input.canonicalInput);
    const indexPath = this.safePath("request-index.json");
    const index = await readJson<RequestIndex>(indexPath, {});
    if (input.requestId && index[input.requestId]) {
      const entry = index[input.requestId];
      if (entry.fingerprint !== fingerprint) throw new Error(`requestId fingerprint mismatch for ${input.requestId}`);
      const manifest = await this.getRun(entry.runId);
      return { runId: entry.runId, manifest, resumed: true, store: this };
    }

    const runId = randomUUID();
    const now = new Date().toISOString();
    await mkdir(this.runDir(runId), { recursive: true });
    const manifest: RunManifest = {
      version: 1,
      runId,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      requestFingerprint: fingerprint,
      status: "running",
      createdAt: now,
      updatedAt: now,
      stages: {},
      assets: [],
      attempts: [],
    };
    await this.writeManifest(manifest);
    if (input.requestId) {
      index[input.requestId] = { runId, fingerprint };
      await atomicWrite(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    }
    return { runId, manifest, resumed: false, store: this };
  }

  async getRun(runId: string): Promise<RunManifest> {
    return readJson<RunManifest>(this.manifestPath(runId));
  }

  async updateStage(runId: string, stage: WorkflowStage, update: StageRecord): Promise<RunManifest> {
    const manifest = await this.getRun(runId);
    manifest.stages[stage] = { ...manifest.stages[stage], ...update };
    return this.writeManifest(manifest);
  }

  async writeStageOutput(runId: string, stage: WorkflowStage, value: unknown): Promise<void> {
    const directory = join(this.runDir(runId), "stages");
    await mkdir(directory, { recursive: true });
    await atomicWrite(join(directory, `${stage}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }

  async readStageOutput<T>(runId: string, stage: WorkflowStage): Promise<{ found: false } | { found: true; value: T }> {
    const manifest = await this.getRun(runId);
    if (manifest.stages[stage]?.status !== "completed") return { found: false };
    try {
      return { found: true, value: await readJson<T>(join(this.runDir(runId), "stages", `${stage}.json`)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { found: false };
      throw error;
    }
  }

  async updateWorkflowData(runId: string, update: Partial<Pick<RunManifest, "sourceHash" | "template" | "slideSpec" | "assets">>): Promise<RunManifest> {
    const manifest = await this.getRun(runId);
    Object.assign(manifest, update);
    return this.writeManifest(manifest);
  }

  async saveAttempt(runId: string, attempt: AttemptRecord, files?: { html?: string; preview?: Buffer; quality?: unknown }): Promise<RunManifest> {
    const directory = join(this.runDir(runId), "attempts", String(attempt.attempt).padStart(2, "0"));
    await mkdir(directory, { recursive: true });
    if (files?.html !== undefined) await atomicWrite(join(directory, "page.html"), files.html);
    if (files?.preview !== undefined) await atomicWrite(join(directory, "preview.png"), files.preview);
    if (files?.quality !== undefined) await atomicWrite(join(directory, "quality.json"), `${JSON.stringify(files.quality, null, 2)}\n`);
    const manifest = await this.getRun(runId);
    manifest.attempts = [...manifest.attempts.filter((item) => item.attempt !== attempt.attempt), attempt].sort((a, b) => a.attempt - b.attempt);
    return this.writeManifest(manifest);
  }

  async promoteAttempt(runId: string, attempt: AttemptRecord): Promise<{ htmlPath: string; previewPath: string; qualityPath: string }> {
    const directory = this.runDir(runId);
    const mappings: Array<[string, string]> = [
      [attempt.htmlPath, join(directory, "final.html")],
      [attempt.previewPath, join(directory, "final.png")],
      [attempt.qualityPath, join(directory, "quality.json")],
    ];
    for (const [source, destination] of mappings) {
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await copyFile(source, temporary);
      await rename(temporary, destination);
    }
    return { htmlPath: mappings[0][1], previewPath: mappings[1][1], qualityPath: mappings[2][1] };
  }

  async finalize(runId: string, update: Pick<RunManifest, "status"> & Partial<Pick<RunManifest, "selectedAttempt" | "finalResult" | "artifacts">>): Promise<RunManifest> {
    const manifest = await this.getRun(runId);
    Object.assign(manifest, update);
    return this.writeManifest(manifest);
  }

  async getArtifact(runId: string, artifactName: ArtifactName): Promise<{ path: string; size: number; text?: string }> {
    const directory = this.runDir(runId);
    if (!ARTIFACTS.has(artifactName)) throw new Error(`Invalid artifact name: ${artifactName}`);
    const path = artifactName === "manifest.json" ? this.manifestPath(runId) : join(directory, artifactName);
    const delta = relative(directory, path);
    if (delta.startsWith("..") || isAbsolute(delta)) throw new Error("Artifact path escapes run directory");
    const metadata = await stat(path);
    const result: { path: string; size: number; text?: string } = { path, size: metadata.size };
    if (metadata.size <= 512 * 1024 && artifactName !== "final.png") result.text = await readFile(path, "utf8");
    return result;
  }
}
