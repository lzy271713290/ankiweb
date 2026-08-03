import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATA_DIRECTORY = path.join(process.cwd(), 'data', 'pdf-import-jobs');
const MAX_TEXT_LENGTH = 120_000;

export type PdfImportStage = 'awaiting_confirmation' | 'running' | 'ready' | 'failed';

export interface PdfImportJob {
  id: string;
  filename: string;
  stage: PdfImportStage;
  progress: number;
  message: string;
  documentId: string;
  paperIds: string[];
  totalPages?: number;
  textLayerPages?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface PdfInspectionText {
  kind: 'text';
  content: string;
}

interface PdfInspectionOcr {
  kind: 'ocr_required';
  job: PdfImportJob;
}

export type PdfInspectionResult = PdfInspectionText | PdfInspectionOcr;

function jobDirectory(jobId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new Error('无效的 OCR 任务编号');
  return path.join(DATA_DIRECTORY, jobId);
}

function jobFile(jobId: string): string {
  return path.join(jobDirectory(jobId), 'status.json');
}

function sourceFile(jobId: string): string {
  return path.join(jobDirectory(jobId), 'source.pdf');
}

async function saveJob(job: PdfImportJob): Promise<void> {
  job.updatedAt = new Date().toISOString();
  const temporaryFile = path.join(jobDirectory(job.id), `status.${randomUUID()}.tmp`);
  await writeFile(temporaryFile, JSON.stringify(job, null, 2), 'utf8');
  await rename(temporaryFile, jobFile(job.id));
}

interface PdfTextInspection {
  text: string;
  totalPages: number;
  textLayerPages: number;
  meaningfulCharacters: number;
}

async function inspectPdfTextLayer(bytes: Buffer): Promise<PdfTextInspection> {
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'),
  ).href;
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  const chunks: string[] = [];
  let storedCharacters = 0;
  let textLayerPages = 0;
  let meaningfulCharacters = 0;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      const pageText = text.items
        .map((item) => ('str' in item ? item.str : ''))
        .filter(Boolean)
        .join(' ')
        .trim();
      const pageCharacters = pageText.replace(/\s/g, '').length;
      meaningfulCharacters += pageCharacters;
      if (pageCharacters >= 10) textLayerPages++;
      if (pageText && storedCharacters < MAX_TEXT_LENGTH) {
        const remaining = MAX_TEXT_LENGTH - storedCharacters;
        chunks.push(pageText.slice(0, remaining));
        storedCharacters += Math.min(pageText.length, remaining);
      }
    }
  } finally {
    await loadingTask.destroy();
  }
  return {
    text: chunks.join('\n\n').replace(/\u0000/g, '').trim(),
    totalPages: document.numPages,
    textLayerPages,
    meaningfulCharacters,
  };
}

function hasUsableTextLayer(inspection: PdfTextInspection): boolean {
  if (inspection.meaningfulCharacters < 80) return false;
  return inspection.textLayerPages / inspection.totalPages >= 0.5;
}

export async function inspectUploadedPdf(file: File): Promise<PdfInspectionResult> {
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('文件内容不是有效的 PDF');
  }
  const id = randomUUID();
  const directory = jobDirectory(id);
  await mkdir(directory, { recursive: true });
  await writeFile(sourceFile(id), bytes);
  try {
    const inspection = await inspectPdfTextLayer(bytes);
    if (hasUsableTextLayer(inspection)) {
      await rm(directory, { recursive: true, force: true });
      return {
        kind: 'text',
        content: inspection.text,
      };
    }
    const documentId = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const now = new Date().toISOString();
    const job: PdfImportJob = {
      id,
      filename: file.name,
      stage: 'awaiting_confirmation',
      progress: 0,
      message: inspection.textLayerPages > 0
        ? `仅 ${inspection.textLayerPages}/${inspection.totalPages} 页检测到可用文字，大部分页面仍是扫描图，需要 OCR 识别后预审核。`
        : `共 ${inspection.totalPages} 页，未检测到可用文字层，需要 OCR 识别后预审核。`,
      documentId,
      paperIds: ['2017-11', '2017-05', '2016-11'].map((slug) => `${documentId}-${slug}`),
      totalPages: inspection.totalPages,
      textLayerPages: inspection.textLayerPages,
      createdAt: now,
      updatedAt: now,
    };
    await saveJob(job);
    return { kind: 'ocr_required', job };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function readPdfImportJob(jobId: string): Promise<PdfImportJob> {
  try {
    return JSON.parse(await readFile(jobFile(jobId), 'utf8')) as PdfImportJob;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('OCR 任务不存在或已过期');
    throw error;
  }
}

async function locateOcrPython(): Promise<string> {
  const explicit = process.env.EXAM_OCR_PYTHON;
  const candidates = [
    explicit,
    path.join(process.cwd(), '.venv-exam', 'Scripts', 'python.exe'),
    path.join(process.cwd(), '.venv-exam', 'bin', 'python'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Try the next configured environment.
    }
  }
  throw new Error('OCR 环境尚未安装。请按 scripts/exam_pipeline/README.md 创建 .venv-exam，或配置 EXAM_OCR_PYTHON。');
}

export async function startPdfImportJob(jobId: string): Promise<PdfImportJob> {
  const job = await readPdfImportJob(jobId);
  if (job.stage === 'running' || job.stage === 'ready') return job;
  const python = await locateOcrPython();
  job.stage = 'running';
  job.progress = 2;
  job.message = '正在启动 OCR 引擎…';
  delete job.error;
  await saveJob(job);

  const child = spawn(python, [
    path.join(process.cwd(), 'scripts', 'exam_pipeline', 'import_exam_pdf.py'),
    '--source', sourceFile(jobId),
    '--copy-source',
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let errorOutput = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      const match = line.match(/^\[(\d+)\/(\d+)\]\s*(.*)$/);
      if (!match) continue;
      const current = Number(match[1]);
      const total = Math.max(1, Number(match[2]));
      job.progress = Math.min(92, 5 + Math.round((current / total) * 87));
      job.message = `正在 OCR 识别：${match[3] || `第 ${current}/${total} 页`}`;
      void saveJob(job);
    }
  });
  child.stderr.on('data', (chunk: string) => {
    errorOutput = `${errorOutput}${chunk}`.slice(-8_000);
  });
  child.on('error', (error) => {
    job.stage = 'failed';
    job.message = 'OCR 任务启动失败';
    job.error = error.message;
    void saveJob(job);
  });
  child.on('close', (code) => {
    if (code === 0) {
      job.stage = 'ready';
      job.progress = 100;
      job.message = 'OCR 识别完成，请预审核并修改内容。';
      delete job.error;
    } else {
      job.stage = 'failed';
      job.message = 'OCR 识别失败';
      job.error = errorOutput.trim() || `OCR 进程退出码：${code ?? 'unknown'}`;
    }
    void saveJob(job);
  });
  return job;
}
