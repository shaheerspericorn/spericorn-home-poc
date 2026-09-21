import { readFile, rm, writeFile } from "node:fs/promises";
import obj2gltf from "obj2gltf";
import { appConfig } from "../../config.js";
import type { CadConversionService } from "../../types/conversion.js";
import type { ConversionProgress, ConversionResult, ModelRecord } from "../../types/model.js";
import { UserFacingError } from "../../utils/errors.js";
import { FileSystemStorage } from "../../services/storage/file-system-storage.js";

const APS_BASE_URL = "https://developer.api.autodesk.com";
const CAD_2D_MESSAGE = "This file appears to contain 2D CAD data and cannot be used for the 3D villa viewer POC. Please upload a supported 3D CAD/BIM model.";

type ApsManifestNode = {
  guid?: string;
  name?: string;
  status?: string;
  progress?: string;
  outputType?: string;
  role?: string;
  type?: string;
  urn?: string;
  children?: ApsManifestNode[];
  messages?: Array<{ type?: string; message?: string }>;
};

type ApsManifest = ApsManifestNode & { derivatives?: ApsManifestNode[] };

type ApsModelView = {
  guid?: string;
  name?: string;
  role?: string;
};

type ApsModelViews = {
  data?: { metadata?: ApsModelView[] };
};

/**
 * Real APS pipeline:
 * source CAD/BIM -> OSS v2 -> SVF2 3D derivative -> OBJ extraction -> local GLB.
 * APS does not offer a portable "CAD in, GLB out" Model Derivative response for
 * all source formats, so OBJ is intentionally kept as an isolated intermediate.
 */
export class ApsCadConversionService implements CadConversionService {
  readonly provider = "aps" as const;
  readonly isSampleMode = false;

  constructor(private readonly storage: FileSystemStorage) {}

  async convert(
    model: ModelRecord,
    onProgress: (progress: ConversionProgress) => Promise<void>,
  ): Promise<ConversionResult> {
    this.assertConfiguration();
    const token = await this.getAccessToken();

    await onProgress({ status: "processing", progress: 30, stage: "uploading_to_aps" });
    const urn = await this.uploadToOss(model, token);

    await onProgress({ status: "processing", progress: 42, stage: "processing_cad" });
    await this.startSvf2Translation(urn, token);
    const modelGuid = await this.waitForThreeDimensionalView(urn, token);

    await onProgress({ status: "converting", progress: 64, stage: "extracting_3d_geometry" });
    // APS defines [-1] as the all-elements sentinel. It keeps request payloads
    // bounded even for large BIM object trees while still requiring a 3D model GUID.
    await this.startObjExtraction(urn, modelGuid, [-1], token);
    const objDerivativeUrn = await this.waitForObjDerivative(urn, token);

    await onProgress({ status: "post_processing", progress: 84, stage: "generating_glb" });
    const objBytes = await this.downloadDerivative(urn, objDerivativeUrn, token);
    const outputPath = await this.storage.prepareOutput(model.id);

    // obj2gltf accepts a filesystem path (not an in-memory buffer). This intentionally
    // avoids trying to manufacture geometry when APS did not find a 3D view.
    const objPath = outputPath.replace(/\.glb$/, ".obj");
    await writeFile(objPath, Buffer.from(objBytes));
    let glb: Buffer | Record<string, unknown>;
    try {
      glb = await obj2gltf(objPath, { binary: true, secure: true });
    } finally {
      await rm(objPath, { force: true });
    }
    if (!Buffer.isBuffer(glb) || glb.length === 0) {
      throw new UserFacingError("GLB post-processing failed: the extracted geometry was empty.");
    }
    await writeFile(outputPath, glb);

    return {
      success: true,
      modelId: model.id,
      sourceFormat: model.sourceFormat,
      outputFormat: "glb",
      outputPath,
      outputUrl: `/api/models/${model.id}/model.glb`,
      outputBytes: glb.length,
      hierarchy: {
        preserved: false,
        note: "APS SVF2 retains CAD metadata and hierarchy, but OBJ-to-GLB export is geometry-oriented and does not guarantee the original node hierarchy. A future APS Viewer/metadata adapter should expose that tree directly.",
      },
    };
  }

  private assertConfiguration(): void {
    if (!appConfig.aps.clientId || !appConfig.aps.clientSecret) {
      throw new UserFacingError("CAD conversion is not configured. Add APS_CLIENT_ID and APS_CLIENT_SECRET to the backend environment.", 503);
    }
  }

  private async getAccessToken(): Promise<string> {
    const credentials = Buffer.from(`${appConfig.aps.clientId}:${appConfig.aps.clientSecret}`).toString("base64");
    const response = await fetch(`${APS_BASE_URL}/authentication/v2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "bucket:create bucket:read data:read data:write",
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string };
    if (!response.ok || !body.access_token) {
      throw new UserFacingError("APS authentication failed. Verify the server-side APS credentials and app permissions.", 502);
    }
    return body.access_token;
  }

  private bucketKey(): string {
    const explicit = appConfig.aps.bucketKey?.trim().toLowerCase();
    if (explicit) return explicit;
    const client = appConfig.aps.clientId?.toLowerCase().replace(/[^a-z0-9]/g, "");
    return `${client}-spericorn-poc`.slice(0, 128);
  }

  private async uploadToOss(model: ModelRecord, token: string): Promise<string> {
    const bucketKey = this.bucketKey();
    await this.ensureBucket(bucketKey, token);
    const objectKey = `${model.id}/source.${model.sourceFormat}`;
    const objectPath = `${APS_BASE_URL}/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectKey)}`;

    const signedUpload = await this.apsJson<{ uploadKey?: string; urls?: string[] }>(
      `${objectPath}/signeds3upload?parts=1&minutesExpiration=60`,
      token,
    );
    const uploadUrl = signedUpload.urls?.[0];
    if (!signedUpload.uploadKey || !uploadUrl) throw new UserFacingError("APS did not return a signed upload URL.", 502);

    const file = await readFile(model.sourcePath);
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(file.length) },
      body: file,
    });
    if (!uploadResponse.ok) throw new UserFacingError("Uploading the CAD file to APS failed.", 502);

    const completed = await this.apsJson<{ objectId?: string }>(
      `${objectPath}/signeds3upload`,
      token,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Record the binary MIME type in OSS. This is optional for APS, but makes
          // the stored source's type explicit and matches APS's direct-S3 workflow.
          "x-ads-meta-Content-Type": "application/octet-stream",
        },
        // APS requires uploadKey in the JSON payload when completing a signed S3 upload.
        // Putting it in the query string leaves the required payload missing.
        body: JSON.stringify({ uploadKey: signedUpload.uploadKey }),
      },
    );
    if (!completed.objectId) throw new UserFacingError("APS did not confirm the uploaded CAD file.", 502);
    return Buffer.from(completed.objectId).toString("base64url");
  }

  private async ensureBucket(bucketKey: string, token: string): Promise<void> {
    const response = await fetch(`${APS_BASE_URL}/oss/v2/buckets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ bucketKey, policyKey: "transient" }),
    });
    // 409 means the application bucket has already been created.
    if (!response.ok && response.status !== 409) {
      throw new UserFacingError("APS storage setup failed. Check APS_BUCKET_KEY and bucket permissions.", 502);
    }
  }

  private async startSvf2Translation(urn: string, token: string): Promise<void> {
    await this.apsJson(
      `${this.derivativeBaseUrl()}/job`,
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ads-force": "false" },
        body: JSON.stringify({
          input: { urn },
          output: { formats: [{ type: "svf2", views: ["3d"] }] },
        }),
      },
    );
  }

  private async startObjExtraction(urn: string, modelGuid: string, objectIds: number[], token: string): Promise<void> {
    await this.apsJson(
      `${this.derivativeBaseUrl()}/job`,
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ads-force": "false" },
        body: JSON.stringify({
          input: { urn },
          // APS geometry extraction requires both the 3D view GUID and object IDs.
          output: { formats: [{ type: "obj", advanced: { modelGuid, objectIds } }] },
        }),
      },
    );
  }

  private async waitForThreeDimensionalView(urn: string, token: string): Promise<string> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const manifest = await this.getManifest(urn, token);
      const failure = this.failedNode(manifest.derivatives || []);
      if (failure) throw new UserFacingError(`APS translation failed${failure ? `: ${failure}` : "."}`, 502);

      // The manifest has several GUIDs (including view and graphics-resource GUIDs).
      // OBJ geometry extraction accepts the model-view GUID from /metadata only.
      const translatedThreeDimensionalView = this.nodes(manifest.derivatives || []).some(
        (node) => node.role === "3d" && node.type === "geometry" && node.status === "success",
      );
      if (translatedThreeDimensionalView) {
        const modelViews = await this.getModelViews(urn, token);
        const modelGuid = modelViews.data?.metadata?.find((view) => view.role === "3d" && view.guid)?.guid;
        if (modelGuid) return modelGuid;
      }

      if (manifest.status === "success" && !translatedThreeDimensionalView) {
        throw new UserFacingError(CAD_2D_MESSAGE, 422);
      }
      await this.delay();
    }
    throw new UserFacingError("APS translation timed out while waiting for 3D model metadata.", 504);
  }

  private async waitForObjDerivative(urn: string, token: string): Promise<string> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const manifest = await this.getManifest(urn, token);
      const objRoot = this.nodes(manifest.derivatives || []).find((node) => node.outputType === "obj");
      if (objRoot?.status === "failed") throw new UserFacingError("APS could not extract OBJ geometry from the 3D model.", 502);
      const obj = this.nodes(objRoot ? [objRoot] : []).find((node) => node.urn?.toLowerCase().endsWith(".obj") && node.status === "success");
      if (obj?.urn) return obj.urn;
      await this.delay();
    }
    throw new UserFacingError("APS OBJ extraction timed out.", 504);
  }

  private async getManifest(urn: string, token: string): Promise<ApsManifest> {
    return this.apsJson<ApsManifest>(`${this.derivativeBaseUrl()}/${encodeURIComponent(urn)}/manifest`, token);
  }

  private async getModelViews(urn: string, token: string): Promise<ApsModelViews> {
    return this.apsJson<ApsModelViews>(`${this.derivativeBaseUrl()}/${encodeURIComponent(urn)}/metadata`, token);
  }

  private async downloadDerivative(urn: string, derivativeUrn: string, token: string): Promise<ArrayBuffer> {
    const endpoint = `${this.derivativeBaseUrl()}/${encodeURIComponent(urn)}/manifest/${encodeURIComponent(derivativeUrn)}/signedcookies`;
    const signed = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
    if (!signed.ok) throw new UserFacingError("APS derivative download could not be authorised.", 502);
    const data = (await signed.json()) as { url?: string };
    const headerSource = signed.headers as Headers & { getSetCookie?: () => string[] };
    const cookies = (headerSource.getSetCookie?.() || [])
      .map((value) => value.split(";")[0])
      .filter((value) => value.startsWith("CloudFront-"))
      .join("; ");
    if (!data.url || !cookies) throw new UserFacingError("APS did not provide a secure derivative download URL.", 502);
    const download = await fetch(data.url, { headers: { Cookie: cookies } });
    if (!download.ok) throw new UserFacingError("Downloading the APS geometry derivative failed.", 502);
    return download.arrayBuffer();
  }

  private async apsJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...init.headers },
    });
    if (!response.ok) {
      console.error("APS request failed", {
        operation: this.apsOperation(url, init.method),
        status: response.status,
        statusText: response.statusText,
        requestId: response.headers.get("x-request-id") || undefined,
        troubleshooting: response.headers.get("x-ads-troubleshooting") || undefined,
        diagnostic: await this.apsDiagnostic(response),
      });
      throw new UserFacingError(`APS ${this.apsOperation(url, init.method)} failed (${response.status}). See the backend log for the APS diagnostic.`, 502);
    }
    return response.json() as Promise<T>;
  }

  /** Do not log URLs, tokens, or raw responses that may include signed-request data. */
  private async apsDiagnostic(response: Response): Promise<string | undefined> {
    const raw = await response.text().catch(() => "");
    if (!raw) return undefined;

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const message = [parsed.message, parsed.reason, parsed.detail, parsed.developerMessage]
        .find((value): value is string => typeof value === "string" && value.trim().length > 0);
      return message ? this.redactApsDiagnostic(message) : undefined;
    } catch {
      return this.redactApsDiagnostic(raw);
    }
  }

  private redactApsDiagnostic(value: string): string {
    return value
      .replace(/Bearer\s+[^\s,]+/gi, "Bearer [redacted]")
      .replace(/(access[_-]?token|uploadKey)=?[^\s,&]+/gi, "$1=[redacted]")
      .replace(/https?:\/\/\S+/gi, "[URL redacted]")
      .slice(0, 500);
  }

  private apsOperation(url: string, method = "GET"): string {
    const path = new URL(url).pathname;
    if (path.endsWith("/signeds3upload")) return method.toUpperCase() === "POST" ? "signed S3 upload finalization" : "signed S3 upload URL request";
    if (path.endsWith("/job")) return "Model Derivative job";
    if (path.endsWith("/manifest")) return "Model Derivative manifest request";
    if (path.endsWith("/metadata")) return "Model Derivative model views request";
    return "API request";
  }

  private nodes(roots: ApsManifestNode[]): ApsManifestNode[] {
    return roots.flatMap((node) => [node, ...this.nodes(node.children || [])]);
  }

  private failedNode(roots: ApsManifestNode[]): string | undefined {
    const failed = this.nodes(roots).find((node) => node.status === "failed");
    if (!failed) return undefined;
    return failed.messages?.map((message) => message.message).filter(Boolean).join("; ") || failed.name || "unknown error";
  }

  private delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, appConfig.aps.pollIntervalMs));
  }

  private derivativeBaseUrl(): string {
    const region = appConfig.aps.region === "EMEA" ? "/modelderivative/v2/regions/eu/designdata" : "/modelderivative/v2/designdata";
    return `${APS_BASE_URL}${region}`;
  }
}
