import { NextResponse } from "next/server";

export class ApiError extends Error {
  status: number;
  errorCode: string;

  constructor(status: number, errorCode: string, message: string) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

const DB_SCHEMA_HINT =
  "Local database schema is out of sync. Run `npm run db:push` (or `npm run setup`) and restart `npm run dev`.";

const DB_READONLY_HINT =
  "Database file became read-only for the current process. Restart `npm run dev` and avoid rebuilding the DB while the server is running.";

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function errorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return NextResponse.json(
      {
        errorCode: error.errorCode,
        message: error.message,
      },
      { status: error.status },
    );
  }

  const code = getErrorCode(error);
  if (code === "P2021" || code === "P2022") {
    return NextResponse.json(
      {
        errorCode: "DB_SCHEMA_OUTDATED",
        message: DB_SCHEMA_HINT,
      },
      { status: 503 },
    );
  }

  if (code === "SQLITE_READONLY_DBMOVED") {
    return NextResponse.json(
      {
        errorCode: "DB_READONLY_HANDLE",
        message: DB_READONLY_HINT,
      },
      { status: 503 },
    );
  }

  console.error("Unhandled API error:", error);

  return NextResponse.json(
    {
      errorCode: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
    },
    { status: 500 },
  );
}
