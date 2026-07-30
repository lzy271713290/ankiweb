import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), "public", "ankicard-src.zip");
    const fileBuffer = await readFile(filePath);

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="ankicard-src.zip"',
        "Content-Length": fileBuffer.byteLength.toString(),
      },
    });
  } catch {
    // fallback: dynamically zip the source files
    return NextResponse.json(
      { error: "Source archive not found. Please try again later." },
      { status: 404 }
    );
  }
}
