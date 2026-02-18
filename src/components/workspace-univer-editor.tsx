"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceDocumentSaveResponse } from "@/types/agent";

type WorkspaceUniverEditorProps = {
  userId: string;
  filePath: string;
  extension: string;
  version: string;
  onSaved: (response: WorkspaceDocumentSaveResponse) => void;
};

type UniverDocumentKind = "sheet" | "doc" | "slide";

type UniverUnitRef = {
  getId?: () => string;
} | null;

type UniverFacade = {
  createWorkbook: (snapshot: unknown) => UniverUnitRef;
  createUniverDoc: (snapshot: unknown) => UniverUnitRef;
  getActiveWorkbook: () => { save: () => unknown } | null;
  getActiveDocument: () => { save: () => unknown } | null;
  setCurrent?: (unitId: string) => void;
};

type UniverExchangeService = {
  importXLSXToSnapshot?: (file: string | File) => Promise<unknown>;
  importDOCXToSnapshot?: (file: string | File) => Promise<unknown>;
  exportXLSXBySnapshot?: (snapshot: unknown) => Promise<File | undefined>;
  exportDOCXBySnapshot?: (snapshot: unknown) => Promise<File | undefined>;
  _importToSnapshot?: (file: string | File, univerType: number) => Promise<unknown>;
  _exportBySnapshot?: (snapshot: unknown, univerType: number) => Promise<File | undefined>;
};

type UniverSession = {
  dispose: () => void;
  kind: UniverDocumentKind;
  univerAPI?: UniverFacade;
  exchangeService: UniverExchangeService;
  slideUnit?: {
    getSnapshot: () => unknown;
  };
};

type LocalePack = import("@univerjs/core").ILanguagePack;

type UniverLocaleConfig = {
  locale: import("@univerjs/core").LocaleType;
  locales: Record<string, LocalePack>;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "The Univer editor failed to load.";
}

function toUniverDocumentKind(extension: string): UniverDocumentKind | null {
  const normalized = extension.trim().toLowerCase();
  if (normalized === ".xlsx" || normalized === ".xls" || normalized === ".xlsm") {
    return "sheet";
  }

  if (normalized === ".docx" || normalized === ".doc") {
    return "doc";
  }

  if (normalized === ".ppt" || normalized === ".pptx" || normalized === ".pps" || normalized === ".ppsx") {
    return "slide";
  }

  return null;
}

function buildExchangePluginConfig(): Record<string, string> | undefined {
  const configEntries = Object.entries({
    uploadFileServerUrl: process.env.NEXT_PUBLIC_UNIVER_UPLOAD_FILE_URL,
    importServerUrl: process.env.NEXT_PUBLIC_UNIVER_IMPORT_URL,
    exportServerUrl: process.env.NEXT_PUBLIC_UNIVER_EXPORT_URL,
    getTaskServerUrl: process.env.NEXT_PUBLIC_UNIVER_TASK_URL,
    signUrlServerUrl: process.env.NEXT_PUBLIC_UNIVER_SIGN_URL,
    downloadEndpointUrl: process.env.NEXT_PUBLIC_UNIVER_DOWNLOAD_ENDPOINT_URL,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0);

  if (configEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(configEntries);
}

function getBaseName(filePath: string): string {
  const trimmed = filePath.trim();
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separatorIndex < 0) {
    return trimmed || "file";
  }

  const candidate = trimmed.slice(separatorIndex + 1);
  return candidate || "file";
}

function inferMimeType(extension: string): string {
  const normalized = extension.trim().toLowerCase();
  if (normalized === ".xlsx" || normalized === ".xlsm") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }

  if (normalized === ".xls") {
    return "application/vnd.ms-excel";
  }

  if (normalized === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  if (normalized === ".doc") {
    return "application/msword";
  }

  if (normalized === ".ppt") {
    return "application/vnd.ms-powerpoint";
  }

  if (normalized === ".pptx") {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }

  if (normalized === ".pps") {
    return "application/vnd.ms-powerpoint";
  }

  if (normalized === ".ppsx") {
    return "application/vnd.openxmlformats-officedocument.presentationml.slideshow";
  }

  return "application/octet-stream";
}

async function fetchWorkspaceFileAsFile(params: {
  sourceUrl: string;
  filePath: string;
  extension: string;
  userId: string;
}): Promise<File> {
  const response = await fetch(params.sourceUrl, {
    cache: "no-store",
    headers: {
      "x-user-id": params.userId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to load source file (${response.status}) before import.`);
  }

  const payload = await response.blob();
  return new File([payload], getBaseName(params.filePath), {
    type: payload.type || inferMimeType(params.extension),
  });
}

function buildExchangeTroubleshootingMessage(baseMessage: string, exchangeConfig?: Record<string, string>): string {
  if (!exchangeConfig) {
    return `${baseMessage} No Univer exchange endpoint env vars are set. Configure NEXT_PUBLIC_UNIVER_UPLOAD_FILE_URL, NEXT_PUBLIC_UNIVER_IMPORT_URL, NEXT_PUBLIC_UNIVER_EXPORT_URL, NEXT_PUBLIC_UNIVER_TASK_URL, NEXT_PUBLIC_UNIVER_SIGN_URL, and NEXT_PUBLIC_UNIVER_DOWNLOAD_ENDPOINT_URL (or provide same-origin /universer-api endpoints).`;
  }

  const requiredKeys = [
    "uploadFileServerUrl",
    "importServerUrl",
    "exportServerUrl",
    "getTaskServerUrl",
    "signUrlServerUrl",
    "downloadEndpointUrl",
  ] as const;

  const missing = requiredKeys.filter((key) => !exchangeConfig[key]);
  if (missing.length === 0) {
    return baseMessage;
  }

  return `${baseMessage} Missing exchange config keys: ${missing.join(", ")}.`;
}

function getUniverUnitId(unitRef: unknown): string | null {
  if (!unitRef || typeof unitRef !== "object") {
    return null;
  }

  const getId = (unitRef as { getId?: unknown }).getId;
  if (typeof getId !== "function") {
    return null;
  }

  try {
    const id = getId.call(unitRef);
    return typeof id === "string" && id.trim().length > 0 ? id : null;
  } catch {
    return null;
  }
}

function disposeSession(session: UniverSession | null, options?: { defer?: boolean }): void {
  if (!session) {
    return;
  }

  const disposeNow = () => {
    try {
      session.dispose();
    } catch {
      // Ignore disposal errors from third-party DOM teardown.
    }
  };

  if (options?.defer) {
    setTimeout(disposeNow, 0);
    return;
  }

  disposeNow();
}

async function loadLocaleConfig(kind: UniverDocumentKind): Promise<UniverLocaleConfig> {
  if (kind === "slide") {
    const [
      { LocaleType, mergeLocales },
      exchangeLocaleModule,
      designLocaleModule,
      uiLocaleModule,
      slidesLocaleModule,
    ] = await Promise.all([
      import("@univerjs/core"),
      import("@univerjs-pro/exchange-client/locale/en-US"),
      import("@univerjs/design/locale/en-US"),
      import("@univerjs/ui/locale/en-US"),
      import("@univerjs/slides-ui/locale/en-US"),
    ]);

    const locale = LocaleType.EN_US;
    const mergedLocale = mergeLocales(
      exchangeLocaleModule.default as LocalePack,
      designLocaleModule.default as LocalePack,
      uiLocaleModule.default as LocalePack,
      slidesLocaleModule.default as LocalePack,
    ) as LocalePack;

    return {
      locale,
      locales: {
        [locale]: mergedLocale,
      },
    };
  }

  const [{ LocaleType, mergeLocales }, exchangeLocaleModule, presetLocaleModule] = await Promise.all([
    import("@univerjs/core"),
    import("@univerjs-pro/exchange-client/locale/en-US"),
    kind === "sheet"
      ? import("@univerjs/presets/preset-sheets-core/locales/en-US")
      : import("@univerjs/presets/preset-docs-core/locales/en-US"),
  ]);

  const locale = LocaleType.EN_US;
  const mergedLocale = mergeLocales(
    presetLocaleModule.default as LocalePack,
    exchangeLocaleModule.default as LocalePack,
  ) as LocalePack;

  return {
    locale,
    locales: {
      [locale]: mergedLocale,
    },
  };
}

function requireExchangeMethod<T extends keyof UniverExchangeService>(
  exchangeService: UniverExchangeService,
  methodName: T,
  errorMessage: string,
): NonNullable<UniverExchangeService[T]> {
  const method = exchangeService[methodName];
  if (typeof method !== "function") {
    throw new Error(errorMessage);
  }

  return method as NonNullable<UniverExchangeService[T]>;
}

async function importSlideSnapshot(
  exchangeService: UniverExchangeService,
  sourceFile: File,
  exchangeConfig?: Record<string, string>,
): Promise<unknown> {
  const importToSnapshot = requireExchangeMethod(
    exchangeService,
    "_importToSnapshot",
    "Slide import is unavailable in this Univer exchange client build.",
  );
  const { UniverType } = await import("@univerjs/protocol");
  const snapshot = await importToSnapshot(sourceFile, UniverType.UNIVER_SLIDE);
  if (!snapshot) {
    throw new Error(
      buildExchangeTroubleshootingMessage(
        "Slide import returned no snapshot.",
        exchangeConfig,
      ),
    );
  }

  return snapshot;
}

async function exportSlideFile(
  exchangeService: UniverExchangeService,
  slideSnapshot: unknown,
): Promise<File | undefined> {
  const exportBySnapshot = requireExchangeMethod(
    exchangeService,
    "_exportBySnapshot",
    "Slide export is unavailable in this Univer exchange client build.",
  );
  const { UniverType } = await import("@univerjs/protocol");
  return exportBySnapshot(slideSnapshot, UniverType.UNIVER_SLIDE);
}

export function WorkspaceUniverEditor({
  userId,
  filePath,
  extension,
  version,
  onSaved,
}: WorkspaceUniverEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<UniverSession | null>(null);
  const versionRef = useRef(version);
  const mountedRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>("Loading Univer editor…");
  const [error, setError] = useState<string | null>(null);
  const documentKind = useMemo(() => toUniverDocumentKind(extension), [extension]);

  const runIfMounted = useCallback((fn: () => void) => {
    if (mountedRef.current) {
      fn();
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    versionRef.current = version;
  }, [version]);

  useEffect(() => {
    let disposed = false;
    let bootHandle: ReturnType<typeof setTimeout> | null = null;

    const boot = async () => {
      runIfMounted(() => {
        setError(null);
        setLoading(true);
        setStatus("Loading Univer editor…");
      });

      if (!documentKind) {
        runIfMounted(() => {
          setLoading(false);
          setError("Univer editing is currently enabled for .xlsx and .docx files.");
        });
        return;
      }

      const container = containerRef.current;
      if (!container) {
        runIfMounted(() => {
          setLoading(false);
          setError("Editor container is not available.");
        });
        return;
      }
      disposeSession(sessionRef.current);
      sessionRef.current = null;

      try {
        const sourceParams = new URLSearchParams({
          path: filePath,
          userId,
        });
        const sourceUrl = `/api/workspace/file/raw?${sourceParams.toString()}`;

        const presetModulePromise =
          documentKind === "sheet"
            ? import("@univerjs/presets/preset-sheets-core")
            : import("@univerjs/presets/preset-docs-core");
        const docsExchangeModulePromise =
          documentKind === "doc" ? import("@univerjs-pro/docs-exchange-client") : Promise.resolve(null);

        const [
          { createUniver },
          { UniverExchangeClientPlugin, IExchangeService },
          presetModule,
          docsExchangeModule,
          localeConfig,
          sourceFile,
        ] = await Promise.all([
          import("@univerjs/presets"),
          import("@univerjs-pro/exchange-client"),
          presetModulePromise,
          docsExchangeModulePromise,
          loadLocaleConfig(documentKind),
          fetchWorkspaceFileAsFile({
            sourceUrl,
            filePath,
            extension,
            userId,
          }),
        ]);

        if (disposed) {
          return;
        }

        const preset =
          documentKind === "sheet"
            ? (presetModule as typeof import("@univerjs/presets/preset-sheets-core")).UniverSheetsCorePreset({
                container,
              })
            : (presetModule as typeof import("@univerjs/presets/preset-docs-core")).UniverDocsCorePreset({
                container,
              });

        const exchangeConfig = buildExchangePluginConfig();
        const plugins: Parameters<typeof createUniver>[0]["plugins"] = [];
        plugins.push(exchangeConfig ? [UniverExchangeClientPlugin, exchangeConfig] : UniverExchangeClientPlugin);
        if (documentKind === "doc" && docsExchangeModule?.UniverDocsExchangeClientPlugin) {
          plugins.push(docsExchangeModule.UniverDocsExchangeClientPlugin);
        }

        const { univer, univerAPI } = createUniver({
          locale: localeConfig.locale,
          locales: localeConfig.locales,
          presets: [preset],
          plugins,
        });
        let univerDisposed = false;
        const disposeUniver = (defer = false) => {
          if (univerDisposed) {
            return;
          }
          univerDisposed = true;

          const run = () => {
            try {
              univer.dispose();
            } catch {
              // Ignore teardown errors from third-party DOM internals.
            }
          };

          if (defer) {
            setTimeout(run, 0);
            return;
          }

          run();
        };
        const univerFacade = univerAPI as unknown as UniverFacade;
        const exchangeService = univer
          .__getInjector()
          .get(IExchangeService) as unknown as UniverExchangeService | undefined;
        if (!exchangeService) {
          throw new Error("Univer exchange service is unavailable.");
        }

        if (documentKind === "sheet") {
          const snapshot = await exchangeService.importXLSXToSnapshot(sourceFile);
          if (!snapshot) {
            throw new Error(
              buildExchangeTroubleshootingMessage(
                "Spreadsheet import returned no snapshot.",
                exchangeConfig,
              ),
            );
          }
          const workbook = univerFacade.createWorkbook(snapshot);
          if (!univerFacade.getActiveWorkbook()) {
            const workbookId = getUniverUnitId(workbook);
            if (workbookId && typeof univerFacade.setCurrent === "function") {
              try {
                univerFacade.setCurrent(workbookId);
              } catch {
                // Some exchange snapshots already mount the unit and can throw "unit not found" on setCurrent.
              }
            }

            if (!univerFacade.getActiveWorkbook()) {
              throw new Error("Workbook import succeeded, but the workbook did not become active in the editor.");
            }
          }
        } else {
          const snapshot = await exchangeService.importDOCXToSnapshot(sourceFile);
          if (!snapshot) {
            throw new Error(
              buildExchangeTroubleshootingMessage(
                "Document import returned no snapshot.",
                exchangeConfig,
              ),
            );
          }
          const document = univerFacade.createUniverDoc(snapshot);
          if (!univerFacade.getActiveDocument()) {
            const documentId = getUniverUnitId(document);
            if (documentId && typeof univerFacade.setCurrent === "function") {
              try {
                univerFacade.setCurrent(documentId);
              } catch {
                // Some exchange snapshots already mount the unit and can throw "unit not found" on setCurrent.
              }
            }

            if (!univerFacade.getActiveDocument()) {
              throw new Error("Document import succeeded, but the document did not become active in the editor.");
            }
          }
        }

        if (disposed) {
          disposeUniver(true);
          return;
        }

        sessionRef.current = {
          dispose: () => disposeUniver(),
          kind: documentKind,
          univerAPI: univerFacade,
          exchangeService,
        };

        runIfMounted(() => {
          setStatus("Editing in Univer. Save writes back to the workspace file.");
        });
      } catch (loadError) {
        if (!disposed) {
          runIfMounted(() => {
            setStatus("Editor failed to initialize.");
          });
        }
        if (!disposed) {
          runIfMounted(() => {
            setError(toErrorMessage(loadError));
          });
        }
      } finally {
        if (!disposed) {
          runIfMounted(() => {
            setLoading(false);
          });
        }
      }
    };

    bootHandle = setTimeout(() => {
      void boot();
    }, 0);

    return () => {
      disposed = true;
      if (bootHandle !== null) {
        clearTimeout(bootHandle);
      }
      disposeSession(sessionRef.current, { defer: true });
      sessionRef.current = null;
    };
  }, [documentKind, extension, filePath, runIfMounted, userId]);

  const saveDocument = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || saving) {
      return;
    }

    runIfMounted(() => {
      setSaving(true);
      setError(null);
      setStatus("Saving…");
    });

    try {
      const exportedFile =
        session.kind === "sheet"
          ? await (() => {
              const workbook = session.univerAPI.getActiveWorkbook();
              if (!workbook) {
                throw new Error("No active workbook is available to save.");
              }
              return session.exchangeService.exportXLSXBySnapshot(workbook.save());
            })()
          : await (() => {
              const document = session.univerAPI.getActiveDocument();
              if (!document) {
                throw new Error("No active document is available to save.");
              }
              return session.exchangeService.exportDOCXBySnapshot(document.save());
            })();

      if (!exportedFile) {
        throw new Error("Univer export did not return a file payload.");
      }

      const params = new URLSearchParams({
        path: filePath,
        baseVersion: versionRef.current,
      });

      const response = await fetch(`/api/workspace/file/raw?${params.toString()}`, {
        method: "PUT",
        cache: "no-store",
        headers: {
          "x-user-id": userId,
          "content-type": exportedFile.type || "application/octet-stream",
        },
        body: exportedFile,
      });

      const text = await response.text();
      const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (!response.ok) {
        throw new Error(
          typeof payload.message === "string"
            ? payload.message
            : `Save request failed (${response.status}).`,
        );
      }

      const saveResponse = payload as WorkspaceDocumentSaveResponse;
      versionRef.current = saveResponse.version;
      onSaved(saveResponse);
      runIfMounted(() => {
        setStatus("Saved in workspace.");
      });
    } catch (saveError) {
      runIfMounted(() => {
        setError(toErrorMessage(saveError));
        setStatus("Save failed.");
      });
    } finally {
      runIfMounted(() => {
        setSaving(false);
      });
    }
  }, [filePath, onSaved, runIfMounted, saving, userId]);

  return (
    <div className="ow-univer-wrap">
      <div className="ow-univer-toolbar">
        <p className="ow-hint">{status}</p>
        <button type="button" className="ow-files-refresh" onClick={() => void saveDocument()} disabled={loading || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error ? (
        <p className="ow-error" role="status" aria-live="polite">
          {error}
        </p>
      ) : null}
      {loading ? <p className="ow-hint">Initializing editor…</p> : null}
      <div className="ow-univer-surface" ref={containerRef} />
    </div>
  );
}
