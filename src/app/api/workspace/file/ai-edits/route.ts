import { stat, writeFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { z } from "zod";
import { resolveAgentProvider } from "@/agent/provider";
import { ApiError, errorResponse } from "@/lib/api-error";
import {
  applyWorkspaceTextEditOperations,
  diffToSingleReplaceOperation,
} from "@/lib/workspace-edit";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";
import {
  MAX_EDITABLE_FILE_BYTES,
  normalizeWorkspaceRelativePath,
  readWorkspaceFileInfo,
} from "@/server/workspace-files";
import type { WorkspaceDocumentAiEditRequest, WorkspaceDocumentAiEditEvent } from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

const editRequestSchema = z.object({
  path: z.string().min(1),
  instruction: z.string().trim().min(1).max(4000),
  content: z.string(),
  baseVersion: z.string().optional(),
  autoSave: z.boolean().optional(),
  selection: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .optional(),
});

function toSseChunk(eventName: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

function extractUpdatedDocument(raw: string): string {
  const taggedMatch = raw.match(/<updated_document>([\s\S]*?)<\/updated_document>/i);
  if (taggedMatch) {
    return taggedMatch[1] ?? "";
  }

  const fencedMatch = raw.match(/```(?:\w+)?\n([\s\S]*?)```/);
  if (fencedMatch) {
    return fencedMatch[1] ?? "";
  }

  return raw;
}

export async function POST(request: NextRequest) {
  try {
    requireUserIdHeader(request);

    const body = editRequestSchema.parse(
      await parseJsonBody<WorkspaceDocumentAiEditRequest>(request),
    );
    const relativePath = normalizeWorkspaceRelativePath(body.path);
    const fileInfo = await readWorkspaceFileInfo(relativePath);

    if (!fileInfo.editable) {
      throw new ApiError(
        400,
        "FILE_NOT_EDITABLE",
        "This file type is not editable through the current text adapter.",
      );
    }

    if (body.baseVersion && body.baseVersion !== fileInfo.version) {
      throw new ApiError(
        409,
        "FILE_VERSION_CONFLICT",
        "The file changed on disk. Reload before applying AI edits.",
      );
    }

    const contentBytes = Buffer.byteLength(body.content, "utf8");
    if (contentBytes > MAX_EDITABLE_FILE_BYTES) {
      throw new ApiError(
        413,
        "FILE_TOO_LARGE",
        `File is too large for AI edit mode. Limit is ${MAX_EDITABLE_FILE_BYTES} bytes.`,
      );
    }

    if (body.selection && body.selection.end < body.selection.start) {
      throw new ApiError(400, "INVALID_SELECTION", "Selection range is invalid.");
    }

    const provider = resolveAgentProvider();
    if (provider.name === "mock") {
      throw new ApiError(
        503,
        "AI_PROVIDER_NOT_CONFIGURED",
        "Set OPENAI_API_KEY or ANTHROPIC_API_KEY to enable AI document edits.",
      );
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;

        const close = () => {
          if (closed) {
            return;
          }
          closed = true;
          try {
            controller.close();
          } catch {
            // no-op if already closed
          }
        };

        const sendEvent = (event: WorkspaceDocumentAiEditEvent) => {
          if (closed) {
            return;
          }
          try {
            controller.enqueue(toSseChunk(event.event, event));
          } catch {
            closed = true;
          }
        };

        request.signal.addEventListener("abort", close, { once: true });

        void (async () => {
          try {
            sendEvent({
              event: "ready",
              path: relativePath,
              version: fileInfo.version,
            });

            const selectionContext =
              body.selection && body.selection.start <= body.content.length
                ? body.content.slice(
                    body.selection.start,
                    Math.min(body.selection.end, body.content.length),
                  )
                : null;

            const prompt = [
              `File path: ${relativePath}`,
              `Instruction:\n${body.instruction}`,
              body.selection
                ? `User selection range: [${body.selection.start}, ${body.selection.end}]`
                : "User selection range: none",
              selectionContext !== null
                ? `Selected text:\n<selection>\n${selectionContext}\n</selection>`
                : null,
              "Current content:",
              `<document>\n${body.content}\n</document>`,
              "Return only the fully updated document enclosed in <updated_document>...</updated_document>.",
            ]
              .filter((part) => part && part.length > 0)
              .join("\n\n");

            const providerResult = await provider.runTurn({
              message: prompt,
              history: [],
              relevantContext: "",
              systemPrompt:
                "You are a precise document editor. Apply the user's instruction to the supplied text and preserve everything not requested to change.",
              maxSteps: 1,
            });

            const updatedContent = extractUpdatedDocument(providerResult.text);
            const operations = diffToSingleReplaceOperation(body.content, updatedContent);
            const verified = applyWorkspaceTextEditOperations(body.content, operations);

            if (verified !== updatedContent) {
              throw new ApiError(
                500,
                "EDIT_VERIFICATION_FAILED",
                "AI edit operation verification failed.",
              );
            }

            operations.forEach((operation, index) => {
              sendEvent({
                event: "operation",
                operation,
                index,
                total: operations.length,
              });
            });

            const shouldSave = body.autoSave ?? true;
            if (shouldSave && operations.length > 0) {
              await writeFile(fileInfo.absolutePath, verified, "utf8");
              const nextStats = await stat(fileInfo.absolutePath);
              sendEvent({
                event: "saved",
                version: String(nextStats.mtimeMs),
                sizeBytes: nextStats.size,
                updatedAt: nextStats.mtime.toISOString(),
              });
            }

            sendEvent({
              event: "done",
              summary: operations.length === 0 ? "No changes were needed." : "Applied AI edit operation.",
              operations: operations.length,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "An unexpected error occurred during AI edit.";
            sendEvent({
              event: "error",
              message,
            });
          } finally {
            close();
          }
        })();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(
        new ApiError(400, "INVALID_BODY", error.issues[0]?.message ?? "Invalid request body."),
      );
    }
    return errorResponse(error);
  }
}
