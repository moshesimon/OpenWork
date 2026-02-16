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

  console.error("Unhandled API error:", error);

  return NextResponse.json(
    {
      errorCode: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
    },
    { status: 500 },
  );
}
