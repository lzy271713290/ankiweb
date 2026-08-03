from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean
from typing import Any, Iterable, Sequence

import cv2
import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = ROOT / "data" / "exam-content.sqlite"
DEFAULT_UPLOADS = ROOT / "data" / "uploads"
DEFAULT_ASSETS = ROOT / "data" / "exam-assets"
SCHEMA_PATH = Path(__file__).with_name("schema.sql")
CORRECTIONS_PATH = Path(__file__).with_name("corrections.json")


@dataclass(frozen=True)
class PaperSpec:
    slug: str
    title: str
    year: int
    period: str
    page_from: int
    page_to: int


PAPERS = (
    PaperSpec("2017-11", "2017年11月系统集成项目管理工程师真题", 2017, "11月", 232, 256),
    PaperSpec("2017-05", "2017年05月系统集成项目管理工程师真题", 2017, "05月", 257, 282),
    PaperSpec("2016-11", "2016年11月系统集成项目管理工程师真题", 2016, "11月", 283, 305),
)

FIXED_MASKS = (
    # 页眉下方紧接正文，遮罩不得覆盖续页第一题。
    (0.0, 0.0, 1.0, 0.035, "重复页眉"),
    # 选择题经常贴近页脚，92.5% 会切掉末行字形底部；只遮真正的底部广告区。
    (0.0, 0.955, 1.0, 1.0, "页码及底部广告"),
)

# 该页的大块二维码推广已人工核对；保留上方题目和答案。
PAGE_MASKS = {
    251: ((0.04, 0.70, 0.96, 0.92, "二维码推广区"),),
    277: ((0.04, 0.57, 0.96, 0.84, "二维码推广区"),),
    299: ((0.04, 0.58, 0.96, 0.84, "二维码推广区"),),
    305: ((0.04, 0.57, 0.96, 0.82, "二维码推广区"),),
}

QUESTION_START_RE = re.compile(r"^\s*(\d{1,2})\s*[、.．:：]\s*(.+)$")
PAIR_START_RE = re.compile(
    r"^\s*(\d{1,2})\s*[-—~～]\s*(\d{1,2})\s*[、.．:：]\s*(.+)$"
)
ANSWER_RE = re.compile(r"[【\[]\s*答案\s*[】\]]\s*[:：]?\s*([A-D√×对错]+)", re.IGNORECASE)
# 仅作为字段边界使用，避免“【签案】f”等低置信度 OCR 结果被并入 D 选项；
# 不从模糊结果猜测答案，答案仍需二次识别或人工确认。
POSSIBLE_ANSWER_MARKER_RE = re.compile(
    r"[【\[]\s*[\u4e00-\u9fff]{1,3}案\s*[】\]]\s*[:：]?\s*[A-Za-z√×对错]?",
    re.IGNORECASE,
)
EXPLANATION_RE = re.compile(r"[【\[]\s*解析\s*[】\]]\s*[:：]?")
OPTION_RE = re.compile(r"(?<![A-Za-z0-9])([A-D])\s*[.．:：]\s*")
OPTION_IDEOGRAPHIC_COMMA_RE = re.compile(r"([A-D])\s*、\s*")
PRINTED_PAGE_SUFFIX_RE = re.compile(r"\s*-\s*\d{1,3}\s*-\s*$")
CASE_RE = re.compile(r"^(案例[一二三四五六]|试题[一二三四五六])")
CASE_SECTION_RE = re.compile(r"^(案例|试题)\s*([一二三四五六])")
CASE_QUESTION_RE = re.compile(r"[【\[]\s*问题\s*(\d+)\s*[】\]]")
REFERENCE_ANSWER_RE = re.compile(r"^\s*(?:[【\[]\s*)?参考答案(?:\s*[】\]])?\s*$")
CHINESE_NUMBERS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6}


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def apply_seed_corrections(connection: sqlite3.Connection, document_id: str) -> None:
    if not CORRECTIONS_PATH.exists():
        return
    payload = json.loads(CORRECTIONS_PATH.read_text(encoding="utf-8"))
    document = payload.get("documents", {}).get(document_id, {})
    now = utc_now()
    for correction in document.get("questions", []):
        options = correction.get("options")
        connection.execute(
            """
            INSERT INTO question_corrections (
              question_id, stem, options_json, answer, explanation,
              review_status, note, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'edited', ?, ?)
            ON CONFLICT(question_id) DO NOTHING
            """,
            (
                correction["question_id"],
                correction.get("stem"),
                json.dumps(options, ensure_ascii=False) if options is not None else None,
                correction.get("answer"),
                correction.get("explanation"),
                correction.get("note", "版本化原页核对修订"),
                now,
            ),
        )
    for override in document.get("assets", []):
        connection.execute(
            """
            INSERT INTO question_asset_overrides (asset_id, display_mode, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(asset_id) DO NOTHING
            """,
            (override["asset_id"], override["display_mode"], now),
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="离线导入扫描版软考真题到 SQLite")
    parser.add_argument("--source", type=Path, required=True, help="原始 PDF 路径")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--uploads", type=Path, default=DEFAULT_UPLOADS)
    parser.add_argument("--assets", type=Path, default=DEFAULT_ASSETS)
    parser.add_argument("--papers", nargs="*", choices=[paper.slug for paper in PAPERS])
    parser.add_argument("--sample-pages", help="逗号分隔的 PDF 物理页码；不填则处理所选试卷全部页面")
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument("--copy-source", action="store_true", help="复制原始 PDF 到私有 uploads 目录")
    parser.add_argument("--skip-ocr", action="store_true", help="只登记并渲染页面，不执行 OCR")
    parser.add_argument("--force-render", action="store_true", help="按当前 DPI 重新渲染已有页面")
    parser.add_argument("--questions-only", action="store_true", help="复用现有 OCR，只重建题目和审核报告")
    parser.add_argument("--pdftoppm", type=Path, help="pdftoppm 可执行文件路径")
    parser.add_argument("--pdfinfo", type=Path, help="pdfinfo 可执行文件路径")
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def locate_poppler(name: str, explicit: Path | None) -> Path:
    if explicit:
        path = explicit.resolve()
        if not path.exists():
            raise FileNotFoundError(f"找不到 {name}: {path}")
        return path
    candidates = sorted(
        (Path.home() / ".cache" / "codex-runtimes").glob(
            f"**/dependencies/native/poppler/Library/bin/{name}.exe"
        )
    )
    if candidates:
        return candidates[-1]
    located = shutil.which(name)
    if located:
        return Path(located)
    raise FileNotFoundError(f"找不到 {name}，请通过 --{name} 指定 Poppler 路径")


def pdf_page_count(pdfinfo: Path, source: Path) -> int:
    result = subprocess.run(
        [str(pdfinfo), str(source)],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    matched = re.search(r"^Pages:\s+(\d+)$", result.stdout, re.MULTILINE)
    if not matched:
        raise RuntimeError("pdfinfo 未返回页数")
    return int(matched.group(1))


def connect_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    return connection


def register_document(
    connection: sqlite3.Connection,
    source: Path,
    uploads: Path,
    digest: str,
    page_count: int,
    copy_source: bool,
) -> tuple[str, Path]:
    document_id = digest[:16]
    stored_path = source.resolve()
    if copy_source:
        target_dir = uploads / document_id
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / "source.pdf"
        if not target.exists() or target.stat().st_size != source.stat().st_size:
            shutil.copy2(source, target)
        stored_path = target.resolve()
    now = utc_now()
    connection.execute(
        """
        INSERT INTO source_documents (
          id, filename, sha256, size_bytes, page_count, stored_path, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'registered', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          filename=excluded.filename,
          size_bytes=excluded.size_bytes,
          page_count=excluded.page_count,
          stored_path=excluded.stored_path,
          updated_at=excluded.updated_at
        """,
        (
            document_id,
            source.name,
            digest,
            source.stat().st_size,
            page_count,
            str(stored_path),
            now,
            now,
        ),
    )
    return document_id, stored_path


def register_papers(
    connection: sqlite3.Connection,
    document_id: str,
    specs: Sequence[PaperSpec],
) -> dict[str, str]:
    now = utc_now()
    paper_ids: dict[str, str] = {}
    for spec in specs:
        paper_id = f"{document_id}-{spec.slug}"
        paper_ids[spec.slug] = paper_id
        connection.execute(
            """
            INSERT INTO exam_papers (
              id, document_id, title, year, period, pdf_page_from, pdf_page_to,
              status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'registered', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title=excluded.title,
              pdf_page_from=excluded.pdf_page_from,
              pdf_page_to=excluded.pdf_page_to,
              updated_at=excluded.updated_at
            """,
            (
                paper_id,
                document_id,
                spec.title,
                spec.year,
                spec.period,
                spec.page_from,
                spec.page_to,
                now,
                now,
            ),
        )
        for page in range(spec.page_from, spec.page_to + 1):
            connection.execute(
                """
                INSERT INTO exam_pages (id, paper_id, pdf_page, printed_page, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at
                """,
                (f"{paper_id}-p{page}", paper_id, page, page - 2, now),
            )
    return paper_ids


def register_masks(connection: sqlite3.Connection, document_id: str, page_count: int) -> None:
    # 预设遮罩随脚本版本更新；保留以后由用户编辑器创建的 user 遮罩。
    connection.execute(
        "DELETE FROM page_masks WHERE document_id=? AND source='preset'", (document_id,)
    )
    now = utc_now()
    for x1, y1, x2, y2, label in FIXED_MASKS:
        connection.execute(
            """
            INSERT INTO page_masks (
              document_id, pdf_page_from, pdf_page_to, x1, y1, x2, y2, label, source, created_at
            ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'preset', ?)
            """,
            (document_id, page_count, x1, y1, x2, y2, label, now),
        )
    for page, masks in PAGE_MASKS.items():
        for x1, y1, x2, y2, label in masks:
            connection.execute(
                """
                INSERT INTO page_masks (
                  document_id, pdf_page_from, pdf_page_to, x1, y1, x2, y2, label, source, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preset', ?)
                """,
                (document_id, page, page, x1, y1, x2, y2, label, now),
            )


def selected_pages(specs: Sequence[PaperSpec], sample_pages: str | None) -> list[int]:
    permitted = {
        page
        for spec in specs
        for page in range(spec.page_from, spec.page_to + 1)
    }
    if not sample_pages:
        return sorted(permitted)
    requested = {int(value.strip()) for value in sample_pages.split(",") if value.strip()}
    invalid = sorted(requested - permitted)
    if invalid:
        raise ValueError(f"抽样页不属于所选试卷: {invalid}")
    return sorted(requested)


def render_page(
    pdftoppm: Path, source: Path, page: int, target: Path, dpi: int, force: bool
) -> None:
    if target.exists() and not force:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    prefix = target.with_suffix("")
    subprocess.run(
        [
            str(pdftoppm),
            "-f",
            str(page),
            "-l",
            str(page),
            "-singlefile",
            "-jpeg",
            "-jpegopt",
            "quality=90",
            "-r",
            str(dpi),
            str(source),
            str(prefix),
        ],
        check=True,
        capture_output=True,
    )


def masks_for_page(connection: sqlite3.Connection, document_id: str, page: int) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT * FROM page_masks
        WHERE document_id=? AND enabled=1 AND pdf_page_from<=? AND pdf_page_to>=?
        ORDER BY id
        """,
        (document_id, page, page),
    ).fetchall()


def apply_masks(source: Path, target: Path, masks: Sequence[sqlite3.Row]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as image:
        rendered = image.convert("RGB")
        draw = ImageDraw.Draw(rendered)
        width, height = rendered.size
        for mask in masks:
            draw.rectangle(
                (
                    round(mask["x1"] * width),
                    round(mask["y1"] * height),
                    round(mask["x2"] * width),
                    round(mask["y2"] * height),
                ),
                fill="white",
            )
        rendered.save(target, format="JPEG", quality=90, optimize=True)


def load_ocr_engine() -> Any:
    try:
        from rapidocr import RapidOCR
    except ImportError as error:
        raise RuntimeError(
            "缺少 RapidOCR，请按 scripts/exam_pipeline/README.md 创建 .venv-exam"
        ) from error
    return RapidOCR()


def run_ocr(engine: Any, image_path: Path) -> tuple[str, str, float]:
    result = engine(str(image_path))
    texts = list(result.txts if result.txts is not None else ())
    scores = [float(score) for score in (result.scores if result.scores is not None else ())]
    boxes = [box.tolist() for box in (result.boxes if result.boxes is not None else ())]
    # 宽而低置信度的整行（常见于页末英文题干）单独裁切重识别，避免整页版面干扰。
    with Image.open(image_path) as source_image:
        image_width, image_height = source_image.size
        for index, (text, score, box) in enumerate(zip(texts, scores, boxes, strict=True)):
            xs = [float(point[0]) for point in box]
            ys = [float(point[1]) for point in box]
            if score >= 0.82 or max(xs) - min(xs) < image_width * 0.5:
                continue
            crop = source_image.crop(
                (
                    max(0, round(min(xs)) - 24),
                    max(0, round(min(ys)) - 14),
                    min(image_width, round(max(xs)) + 24),
                    min(image_height, round(max(ys)) + 14),
                )
            ).convert("RGB")
            refined = engine(np.asarray(crop))
            refined_texts = list(refined.txts if refined.txts is not None else ())
            refined_scores = [
                float(value) for value in (refined.scores if refined.scores is not None else ())
            ]
            if not refined_texts or not refined_scores:
                continue
            refined_text = " ".join(refined_texts).strip()
            refined_score = mean(refined_scores)
            if refined_text and refined_score > score + 0.08:
                texts[index] = refined_text
                scores[index] = refined_score
    lines = [
        {"text": text, "score": round(score, 6), "box": box}
        for text, score, box in zip(texts, scores, boxes, strict=True)
    ]
    return "\n".join(texts), json.dumps(lines, ensure_ascii=False), mean(scores) if scores else 0.0


def classify_page(text: str) -> str:
    if re.search(r"20(?:16|17)\s*年\s*(?:05|5|11)\s*月", text):
        return "paper_start"
    if "案例" in text or "试题" in text or "【问题" in text:
        return "case"
    if "【答案】" in text or "【解析】" in text:
        return "choice"
    return "unknown"


def paper_for_page(specs: Sequence[PaperSpec], page: int) -> PaperSpec:
    for spec in specs:
        if spec.page_from <= page <= spec.page_to:
            return spec
    raise ValueError(f"页码不属于已选择试卷: {page}")


def process_pages(
    connection: sqlite3.Connection,
    document_id: str,
    source: Path,
    assets_root: Path,
    pdftoppm: Path,
    pages: Sequence[int],
    specs: Sequence[PaperSpec],
    paper_ids: dict[str, str],
    dpi: int,
    skip_ocr: bool,
    force_render: bool,
) -> None:
    engine = None if skip_ocr else load_ocr_engine()
    page_dir = assets_root / document_id / "pages"
    processed_dir = assets_root / document_id / "processed"
    for index, page in enumerate(pages, start=1):
        source_image = page_dir / f"page-{page:04d}.jpg"
        processed_image = processed_dir / f"page-{page:04d}.jpg"
        print(f"[{index}/{len(pages)}] PDF第{page}页", flush=True)
        render_page(pdftoppm, source, page, source_image, dpi, force_render)
        apply_masks(source_image, processed_image, masks_for_page(connection, document_id, page))
        text = ""
        ocr_json = "[]"
        confidence = 0.0
        status = "rendered"
        kind = "unknown"
        if engine is not None:
            text, ocr_json, confidence = run_ocr(engine, processed_image)
            status = "complete"
            kind = classify_page(text)
        spec = paper_for_page(specs, page)
        paper_id = paper_ids[spec.slug]
        connection.execute(
            """
            UPDATE exam_pages SET
              page_kind=?, source_image_path=?, processed_image_path=?, ocr_text=?, ocr_json=?,
              ocr_mean_confidence=?, ocr_status=?, updated_at=?
            WHERE paper_id=? AND pdf_page=?
            """,
            (
                kind,
                str(source_image.resolve()),
                str(processed_image.resolve()),
                text,
                ocr_json,
                confidence,
                status,
                utc_now(),
                paper_id,
                page,
            ),
        )
        connection.commit()


def split_option_groups(stem: str) -> tuple[str, list[dict[str, str]]]:
    matches = list(OPTION_RE.finditer(stem))
    # Some English questions use the Chinese enumeration comma as the option
    # delimiter. Only use that form as a fallback so text such as “A、B、C三级”
    # inside a normal option is not mistaken for three new options.
    if len(matches) < 2:
        matches = list(OPTION_IDEOGRAPHIC_COMMA_RE.finditer(stem))
    if len(matches) < 2:
        return stem.strip(), []
    question = stem[: matches[0].start()].strip()
    groups: list[dict[str, str]] = []
    options: dict[str, str] = {}
    for index, matched in enumerate(matches):
        label = matched.group(1)
        if label == "A" and options:
            groups.append(options)
            options = {}
        end = matches[index + 1].start() if index + 1 < len(matches) else len(stem)
        value = stem[matched.end() : end].strip()
        options[label] = PRINTED_PAGE_SUFFIX_RE.sub("", value).strip()
    if options:
        groups.append(options)
    return question, groups


def parse_question_start(line: str) -> tuple[int, int, str] | None:
    pair = PAIR_START_RE.match(line)
    if pair:
        return int(pair.group(1)), int(pair.group(2)), pair.group(3)
    single = QUESTION_START_RE.match(line)
    if single:
        return int(single.group(1)), int(single.group(1)), single.group(2)
    return None


def extract_choice_questions(
    connection: sqlite3.Connection,
    paper_id: str,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT pdf_page, ocr_text, ocr_mean_confidence FROM exam_pages
        WHERE paper_id=? AND ocr_status='complete'
        ORDER BY pdf_page
        """,
        (paper_id,),
    ).fetchall()
    line_items: list[tuple[int, str, float]] = []
    for row in rows:
        for line in (row["ocr_text"] or "").splitlines():
            cleaned = line.strip()
            if cleaned:
                line_items.append((row["pdf_page"], cleaned, row["ocr_mean_confidence"] or 0.0))
    starts: list[tuple[int, int, int, str]] = []
    choice_end = len(line_items)
    for index, (_, line, _) in enumerate(line_items):
        if CASE_RE.match(line):
            choice_end = index
            break
        parsed = parse_question_start(line)
        if parsed and 1 <= parsed[0] <= parsed[1] <= 75:
            starts.append((index, parsed[0], parsed[1], parsed[2]))
    questions: list[dict[str, Any]] = []
    for position, (start, number, pair_end, first_content) in enumerate(starts):
        end = starts[position + 1][0] if position + 1 < len(starts) else choice_end
        page, _, _ = line_items[start]
        chunk_items = line_items[start:end]
        chunk_lines = [first_content, *[item[1] for item in chunk_items[1:]]]
        chunk = "\n".join(chunk_lines)
        answer_matches = ANSWER_RE.findall(chunk)
        answer_match = ANSWER_RE.search(chunk)
        possible_answer_marker = POSSIBLE_ANSWER_MARKER_RE.search(chunk)
        explanation_match = EXPLANATION_RE.search(chunk)
        content_end_candidates = [
            candidate.start()
            for candidate in (answer_match, possible_answer_marker, explanation_match)
            if candidate is not None
        ]
        content_end = min(content_end_candidates) if content_end_candidates else len(chunk)
        stem, option_groups = split_option_groups(chunk[:content_end].replace("\n", " "))
        first_answer = answer_matches[0] if answer_matches else ""
        compound_count = max(1, pair_end - number + 1)
        if len(answer_matches) == 1 and 1 < len(first_answer) <= 4:
            compound_count = max(compound_count, len(first_answer))
        if position + 1 < len(starts):
            next_number = starts[position + 1][1]
            if next_number > number + 1 and len(answer_matches) > 1:
                compound_count = max(
                    compound_count,
                    min(next_number - number, len(answer_matches)),
                )
        elif number < 75 and len(answer_matches) > 1:
            compound_count = max(
                compound_count,
                min(76 - number, len(answer_matches)),
            )
        is_structured_compound = pair_end > number or (
            len(answer_matches) == 1
            and len(first_answer) >= compound_count
            and len(option_groups) >= compound_count
        )
        explanation = None
        if explanation_match:
            explanation = chunk[explanation_match.end() :].strip()
        for offset in range(compound_count):
            question_number = number + offset
            if offset == 0 or is_structured_compound:
                question_stem = stem
                if compound_count > 1:
                    question_stem = f"{stem}（第{question_number}空）"
            else:
                question_stem = (
                    f"【需人工确认】OCR未稳定识别第{question_number}题题号或英文题干，请核对来源页。"
                )
            if len(answer_matches) >= compound_count:
                answer = answer_matches[offset][:1]
            elif len(first_answer) >= compound_count:
                answer = first_answer[offset]
            else:
                answer = first_answer or None
            options = option_groups[offset] if offset < len(option_groups) else {}
            questions.append(
                {
                    "number": str(question_number),
                    "stem": question_stem,
                    "options": options,
                    "answer": answer,
                    "explanation": explanation,
                    "page_from": page,
                    "page_to": chunk_items[-1][0],
                    "source_text": chunk,
                    "confidence": mean(item[2] for item in chunk_items),
                }
            )
    # OCR 偶尔会把解析或图表中的数字误判成题号；同题号保留结构最完整的候选。
    deduplicated: dict[str, dict[str, Any]] = {}
    for question in questions:
        number = question["number"]
        if not question["stem"]:
            continue
        current = deduplicated.get(number)
        score = (
            (4 if len(question["options"]) == 4 else len(question["options"]))
            + (4 if question["answer"] else 0)
            + (2 if "需人工确认" not in question["stem"] else 0)
            + (1 if question["page_to"] - question["page_from"] <= 1 else 0)
        )
        current_score = -1
        if current:
            current_score = (
                (4 if len(current["options"]) == 4 else len(current["options"]))
                + (4 if current["answer"] else 0)
                + (2 if "需人工确认" not in current["stem"] else 0)
                + (1 if current["page_to"] - current["page_from"] <= 1 else 0)
            )
        if score > current_score:
            deduplicated[number] = question
    return list(deduplicated.values())


def extract_case_questions(
    connection: sqlite3.Connection,
    paper_id: str,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT pdf_page, ocr_text, ocr_mean_confidence FROM exam_pages
        WHERE paper_id=? AND ocr_status='complete'
        ORDER BY pdf_page
        """,
        (paper_id,),
    ).fetchall()
    items: list[tuple[int, str, float]] = []
    for row in rows:
        for line in (row["ocr_text"] or "").splitlines():
            cleaned = line.strip()
            if cleaned:
                items.append((row["pdf_page"], cleaned, row["ocr_mean_confidence"] or 0.0))
    sections: list[tuple[int, str, int]] = []
    for index, (_, line, _) in enumerate(items):
        matched = CASE_SECTION_RE.match(line)
        if matched:
            sections.append((index, f"{matched.group(1)}{matched.group(2)}", CHINESE_NUMBERS[matched.group(2)]))
    questions: list[dict[str, Any]] = []
    for section_position, (start, section_name, section_number) in enumerate(sections):
        end = sections[section_position + 1][0] if section_position + 1 < len(sections) else len(items)
        section_items = items[start:end]
        reference_index = next(
            (
                index
                for index, (_, line, _) in enumerate(section_items)
                if REFERENCE_ANSWER_RE.match(line)
            ),
            -1,
        )
        if reference_index >= 0:
            prompt_items = section_items[1:reference_index]
            answer_items = section_items[reference_index + 1 :]
        else:
            seen_question_numbers: set[int] = set()
            repeated_question_index = -1
            for index, (_, line, _) in enumerate(section_items):
                matched = CASE_QUESTION_RE.search(line)
                if not matched:
                    continue
                number = int(matched.group(1))
                if number in seen_question_numbers:
                    repeated_question_index = index
                    break
                seen_question_numbers.add(number)
            if repeated_question_index >= 0:
                prompt_items = section_items[1:repeated_question_index]
                answer_items = section_items[repeated_question_index:]
            else:
                prompt_items = section_items[1:]
                answer_items = []
        prompt_markers = [
            (index, int(matched.group(1)))
            for index, (_, line, _) in enumerate(prompt_items)
            if (matched := CASE_QUESTION_RE.search(line))
        ]
        if not prompt_markers:
            continue
        context_items = prompt_items[: prompt_markers[0][0]]
        context = "\n".join(item[1] for item in context_items).strip()
        answer_markers = [
            (index, int(matched.group(1)))
            for index, (_, line, _) in enumerate(answer_items)
            if (matched := CASE_QUESTION_RE.search(line))
        ]
        answer_map: dict[int, str] = {}
        for marker_position, (answer_start, answer_number) in enumerate(answer_markers):
            answer_end = (
                answer_markers[marker_position + 1][0]
                if marker_position + 1 < len(answer_markers)
                else len(answer_items)
            )
            answer_map[answer_number] = "\n".join(
                item[1] for item in answer_items[answer_start + 1 : answer_end]
            ).strip()
        for marker_position, (question_start, question_number) in enumerate(prompt_markers):
            question_end = (
                prompt_markers[marker_position + 1][0]
                if marker_position + 1 < len(prompt_markers)
                else len(prompt_items)
            )
            question_items = prompt_items[question_start:question_end]
            marker_line = CASE_QUESTION_RE.sub("", question_items[0][1]).strip()
            question_text = "\n".join(
                [marker_line, *[item[1] for item in question_items[1:]]]
            ).strip()
            stem = f"{context}\n\n{question_text}".strip() if context else question_text
            page_values = [item[0] for item in question_items]
            questions.append(
                {
                    "section": section_name,
                    "section_number": section_number,
                    "number": str(question_number),
                    "stem": stem,
                    "answer": answer_map.get(question_number),
                    "page_from": min(page_values),
                    "page_to": max(page_values),
                    "source_text": "\n".join(item[1] for item in section_items),
                    "confidence": mean(item[2] for item in question_items),
                }
            )
    deduplicated: dict[tuple[int, str], dict[str, Any]] = {}
    for question in questions:
        key = (question["section_number"], question["number"])
        current = deduplicated.get(key)
        score = (4 if question["answer"] else 0) + min(len(question["stem"]), 500) / 500
        current_score = -1.0
        if current:
            current_score = (4 if current["answer"] else 0) + min(len(current["stem"]), 500) / 500
        if score > current_score:
            deduplicated[key] = question
    return list(deduplicated.values())


def store_questions(connection: sqlite3.Connection, paper_id: str) -> dict[str, int]:
    choice_questions = extract_choice_questions(connection, paper_id)
    case_questions = extract_case_questions(connection, paper_id)
    connection.execute("DELETE FROM exam_questions WHERE paper_id=?", (paper_id,))
    now = utc_now()
    for question in choice_questions:
        connection.execute(
            """
            INSERT INTO exam_questions (
              id, paper_id, question_type, section, question_no, stem, options_json,
              answer, explanation, source_page_from, source_page_to, source_text,
              confidence, review_status, updated_at
            ) VALUES (?, ?, 'choice', '上午选择题', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
            """,
            (
                f"{paper_id}-choice-{int(question['number']):02d}",
                paper_id,
                question["number"],
                question["stem"],
                json.dumps(question["options"], ensure_ascii=False),
                question["answer"],
                question["explanation"],
                question["page_from"],
                question["page_to"],
                question["source_text"],
                question["confidence"],
                now,
            ),
        )
    for question in case_questions:
        connection.execute(
            """
            INSERT INTO exam_questions (
              id, paper_id, question_type, section, question_no, stem, options_json,
              answer, explanation, source_page_from, source_page_to, source_text,
              confidence, review_status, updated_at
            ) VALUES (?, ?, 'case', ?, ?, ?, '{}', NULL, ?, ?, ?, ?, ?, 'pending', ?)
            """,
            (
                f"{paper_id}-case-{question['section_number']:02d}-{int(question['number']):02d}",
                paper_id,
                question["section"],
                question["number"],
                question["stem"],
                question["answer"],
                question["page_from"],
                question["page_to"],
                question["source_text"],
                question["confidence"],
                now,
            ),
        )
    connection.commit()
    return {"choice": len(choice_questions), "case": len(case_questions)}


def box_bounds(item: dict[str, Any]) -> tuple[float, float, float, float]:
    points = item.get("box") or []
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    if not xs or not ys:
        raise ValueError("OCR 文本框缺少坐标")
    return min(xs), min(ys), max(xs), max(ys)


def merge_vertical_bands(
    bands: Sequence[tuple[int, int]], max_gap: int = 36
) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for top, bottom in sorted(bands):
        if not merged or top > merged[-1][1] + max_gap:
            merged.append((top, bottom))
        else:
            merged[-1] = (merged[-1][0], max(merged[-1][1], bottom))
    return merged


def detect_figure_bands(
    image_path: Path, ocr_items: Sequence[dict[str, Any]]
) -> list[tuple[int, int]]:
    """识别真正的图表区域；普通 OCR 文字行不会生成图片资产。"""
    image = cv2.imread(str(image_path))
    if image is None:
        return []
    blue, green, red = cv2.split(image)
    maximum = np.maximum(np.maximum(blue, green), red)
    minimum = np.minimum(np.minimum(blue, green), red)
    # 只保留接近黑灰色的印刷内容，排除红色广告和斜向水印。
    neutral_ink = ((maximum < 220) & ((maximum - minimum) < 45)).astype(np.uint8) * 255
    height, width = neutral_ink.shape

    # 去除 OCR 已覆盖的文字框，剩余的大块连线、图标和边框视为图形候选。
    graphics = neutral_ink.copy()
    for item in ocr_items:
        try:
            left, top, right, bottom = box_bounds(item)
        except ValueError:
            continue
        cv2.rectangle(
            graphics,
            (max(0, round(left) - 5), max(0, round(top) - 4)),
            (min(width - 1, round(right) + 5), min(height - 1, round(bottom) + 4)),
            0,
            -1,
        )
    graphics[: round(height * 0.04), :] = 0
    graphics[round(height * 0.925) :, :] = 0
    graphics = cv2.morphologyEx(
        graphics,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (25, 13)),
    )
    graphics = cv2.dilate(
        graphics, cv2.getStructuringElement(cv2.MORPH_RECT, (31, 21))
    )

    bands: list[tuple[int, int]] = []
    _, _, stats, _ = cv2.connectedComponentsWithStats(graphics, 8)
    for left, top, component_width, component_height, area in stats[1:]:
        if (
            component_width > width * 0.14
            and component_height > height * 0.045
            and area > 2500
        ):
            bands.append((int(top), int(top + component_height)))

    # 表格文字会切断边框，额外用长横线/竖线检测恢复表格区域。
    horizontal = cv2.morphologyEx(
        neutral_ink,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (45, 1)),
    )
    vertical = cv2.morphologyEx(
        neutral_ink,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (1, 32)),
    )
    table_lines = cv2.dilate(
        cv2.bitwise_or(horizontal, vertical),
        cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9)),
    )
    _, _, table_stats, _ = cv2.connectedComponentsWithStats(table_lines, 8)
    for left, top, component_width, component_height, area in table_stats[1:]:
        if (
            component_width > width * 0.2
            and component_height > height * 0.04
            and area > 1200
        ):
            bands.append((int(top), int(top + component_height)))

    return merge_vertical_bands(bands)


def build_choice_explanation_assets(
    connection: sqlite3.Connection,
    document_id: str,
    paper_id: str,
    assets_root: Path,
) -> int:
    """仅裁出真正的题干图或解析图，并关联到对应题目。"""
    connection.execute(
        """
        DELETE FROM question_assets
        WHERE question_id IN (SELECT id FROM exam_questions WHERE paper_id=?)
        """,
        (paper_id,),
    )
    questions = connection.execute(
        """
        SELECT id, question_no, source_page_from, source_page_to
        FROM exam_questions WHERE paper_id=? AND question_type='choice'
        """,
        (paper_id,),
    ).fetchall()
    question_ids = {
        int(row["question_no"]): row["id"]
        for row in questions
    }
    spanning_questions: dict[int, sqlite3.Row] = {}
    max_choice_page = max(int(question["source_page_to"]) for question in questions)
    for question in questions:
        for page in range(int(question["source_page_from"]) + 1, int(question["source_page_to"]) + 1):
            spanning_questions[page] = question
    page_rows = connection.execute(
        """
        SELECT pdf_page, source_image_path, processed_image_path, ocr_json FROM exam_pages
        WHERE paper_id=? AND ocr_status='complete' AND page_kind!='case' ORDER BY pdf_page
        """,
        (paper_id,),
    ).fetchall()
    asset_dir = assets_root / document_id / "question-assets"
    asset_dir.mkdir(parents=True, exist_ok=True)
    created = 0
    for page_row in page_rows:
        if int(page_row["pdf_page"]) > max_choice_page:
            continue
        source_image = Path(page_row["source_image_path"])
        detection_image = Path(page_row["processed_image_path"])
        if not source_image.exists() or not detection_image.exists():
            continue
        items: list[dict[str, Any]] = json.loads(page_row["ocr_json"] or "[]")
        figure_bands = detect_figure_bands(detection_image, items)
        if not figure_bands:
            continue
        starts: list[tuple[int, int, int, float]] = []
        for index, item in enumerate(items):
            parsed = parse_question_start(str(item.get("text") or ""))
            if parsed and 1 <= parsed[0] <= parsed[1] <= 75:
                _, top, _, _ = box_bounds(item)
                starts.append((index, parsed[0], parsed[1], top))
        with Image.open(source_image) as image:
            width, height = image.size
            for band_index, (band_top, band_bottom) in enumerate(figure_bands, start=1):
                band_center = (band_top + band_bottom) / 2
                position = next(
                    (
                        index
                        for index in range(len(starts) - 1, -1, -1)
                        if starts[index][3] <= band_center
                    ),
                    None,
                )
                asset_type = "explanation_figure"
                if position is None:
                    spanning = spanning_questions.get(int(page_row["pdf_page"]))
                    if spanning is None:
                        continue
                    numbers = [int(spanning["question_no"])]
                else:
                    start_index, number, pair_end, _ = starts[position]
                    end_index = starts[position + 1][0] if position + 1 < len(starts) else len(items)
                    chunk_items = items[start_index:end_index]
                    answer_tops = [
                        box_bounds(item)[1]
                        for item in chunk_items
                        if ANSWER_RE.search(str(item.get("text") or ""))
                        or POSSIBLE_ANSWER_MARKER_RE.search(str(item.get("text") or ""))
                    ]
                    explanation_tops = [
                        box_bounds(item)[1]
                        for item in chunk_items
                        if EXPLANATION_RE.search(str(item.get("text") or ""))
                    ]
                    answer_top = min(answer_tops) if answer_tops else None
                    explanation_top = min(explanation_tops) if explanation_tops else None
                    if answer_top is None or band_center < answer_top:
                        asset_type = "question_figure"
                    elif explanation_top is None or band_center < explanation_top:
                        continue
                    numbers = list(range(number, pair_end + 1))
                crop_left = round(width * 0.055)
                crop_top = max(0, round(band_top - 18))
                crop_right = round(width * 0.945)
                crop_bottom_int = min(height, round(band_bottom + 18))
                if crop_bottom_int - crop_top < 60:
                    continue
                for question_number in numbers:
                    question_id = question_ids.get(question_number)
                    if not question_id:
                        continue
                    asset_suffix = f"p{int(page_row['pdf_page']):04d}-b{band_index:02d}"
                    filename = f"{question_id}-{asset_type}-{asset_suffix}.jpg"
                    target = asset_dir / filename
                    image.crop((crop_left, crop_top, crop_right, crop_bottom_int)).convert("RGB").save(
                        target, format="JPEG", quality=92, optimize=True
                    )
                    connection.execute(
                        """
                        INSERT INTO question_assets (
                          id, question_id, asset_type, source_page,
                          x1, y1, x2, y2, file_path, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            f"{question_id}-{asset_type}-{asset_suffix}",
                            question_id,
                            asset_type,
                            int(page_row["pdf_page"]),
                            crop_left / width,
                            crop_top / height,
                            crop_right / width,
                            crop_bottom_int / height,
                            str(target.resolve()),
                            utc_now(),
                        ),
                    )
                    created += 1
    connection.commit()
    return created


def relative_uri(from_dir: Path, target: Path) -> str:
    return Path(os.path.relpath(target, from_dir)).as_posix()


def text_without_figure_ocr(
    text: str | None,
    asset_type: str,
    assets: Sequence[sqlite3.Row],
    page_context: dict[int, tuple[list[dict[str, Any]], int, int]],
) -> str:
    if not text:
        return ""
    removed_texts: set[str] = set()
    for asset in assets:
        if asset["asset_type"] != asset_type:
            continue
        context = page_context.get(int(asset["source_page"]))
        if context is None:
            continue
        ocr_items, width, height = context
        for item in ocr_items:
            try:
                left, top, right, bottom = box_bounds(item)
            except ValueError:
                continue
            center_x = (left + right) / 2 / width
            center_y = (top + bottom) / 2 / height
            if (
                float(asset["x1"]) <= center_x <= float(asset["x2"])
                and float(asset["y1"]) <= center_y <= float(asset["y2"])
            ):
                value = str(item.get("text") or "").strip()
                if value:
                    removed_texts.add(value)
    cleaned = text
    for value in sorted(removed_texts, key=len, reverse=True):
        if len(value) == 1:
            cleaned = re.sub(rf"(?<!\w){re.escape(value)}(?!\w)", " ", cleaned)
        else:
            cleaned = cleaned.replace(value, " ")
    cleaned_lines = [re.sub(r"\s+", " ", line).strip() for line in cleaned.splitlines()]
    return "\n".join(line for line in cleaned_lines if line).strip()


def build_review_report(
    connection: sqlite3.Connection,
    document_id: str,
    assets_root: Path,
    specs: Sequence[PaperSpec],
    paper_ids: dict[str, str],
) -> Path:
    review_dir = assets_root / document_id / "review"
    review_dir.mkdir(parents=True, exist_ok=True)
    report_path = review_dir / "index.html"
    sections: list[str] = []
    for spec in specs:
        paper_id = paper_ids[spec.slug]
        pages = connection.execute(
            """
            SELECT pdf_page, page_kind, source_image_path, processed_image_path, ocr_text, ocr_json,
                   ocr_mean_confidence, ocr_status
            FROM exam_pages WHERE paper_id=? ORDER BY pdf_page
            """,
            (paper_id,),
        ).fetchall()
        page_context: dict[int, tuple[list[dict[str, Any]], int, int]] = {}
        for page_row in pages:
            with Image.open(page_row["source_image_path"]) as page_image:
                page_context[int(page_row["pdf_page"])] = (
                    json.loads(page_row["ocr_json"] or "[]"),
                    page_image.width,
                    page_image.height,
                )
        questions = connection.execute(
            """
            SELECT q.id, q.question_no,
                   COALESCE(c.stem, q.stem) AS stem,
                   COALESCE(c.options_json, q.options_json) AS options_json,
                   COALESCE(c.answer, q.answer) AS answer,
                   COALESCE(c.explanation, q.explanation) AS explanation,
                   q.source_page_from, q.source_page_to, q.confidence,
                   COALESCE(c.review_status, q.review_status) AS review_status
            FROM exam_questions q
            LEFT JOIN question_corrections c ON c.question_id=q.id
            WHERE q.paper_id=? AND q.question_type='choice'
            ORDER BY CAST(q.question_no AS INTEGER)
            """,
            (paper_id,),
        ).fetchall()
        asset_rows = connection.execute(
            """
            SELECT a.question_id, a.asset_type, a.source_page, a.file_path,
                   a.x1, a.y1, a.x2, a.y2
            FROM question_assets a
            JOIN exam_questions q ON q.id=a.question_id
            WHERE q.paper_id=? ORDER BY a.source_page, a.id
            """,
            (paper_id,),
        ).fetchall()
        assets_by_question: dict[str, list[sqlite3.Row]] = {}
        for asset in asset_rows:
            assets_by_question.setdefault(asset["question_id"], []).append(asset)
        case_questions = connection.execute(
            """
            SELECT section, question_no, stem, explanation, source_page_from, confidence
            FROM exam_questions WHERE paper_id=? AND question_type='case'
            ORDER BY section, CAST(question_no AS INTEGER)
            """,
            (paper_id,),
        ).fetchall()
        found = {int(row["question_no"]) for row in questions}
        missing = [number for number in range(1, 76) if number not in found]
        question_cards: list[str] = []
        issue_links: list[str] = []
        for row in questions:
            options = json.loads(row["options_json"] or "{}")
            issue_reasons: list[str] = []
            if len(options) != 4:
                issue_reasons.append(f"选项不完整（{len(options)}/4）")
            if not row["answer"]:
                issue_reasons.append("缺少答案")
            if not row["explanation"]:
                issue_reasons.append("缺少解析")
            question_id = f"{spec.slug}-choice-{row['question_no']}"
            if issue_reasons:
                issue_links.append(
                    f"<a href='#{question_id}'>第{html.escape(row['question_no'])}题："
                    f"{html.escape('、'.join(issue_reasons))}</a>"
                )
            option_items = "".join(
                f"<li class='option{' missing' if label not in options else ''}'>"
                f"<strong>{label}.</strong> {html.escape(options.get(label, '未识别'))}</li>"
                for label in "ABCD"
            )
            source_from = int(row["source_page_from"])
            source_to = int(row["source_page_to"] or source_from)
            page_label = (
                f"PDF第{source_from}页"
                if source_from == source_to
                else f"PDF第{source_from}-{source_to}页"
            )
            source_image = assets_root / document_id / "pages" / f"page-{source_from:04d}.jpg"
            question_assets = assets_by_question.get(row["id"], [])
            stem_text = text_without_figure_ocr(
                row["stem"], "question_figure", question_assets, page_context
            )
            explanation_text = text_without_figure_ocr(
                row["explanation"], "explanation_figure", question_assets, page_context
            )
            connection.execute(
                """
                INSERT INTO question_display_text (question_id, stem, explanation, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(question_id) DO UPDATE SET
                  stem=excluded.stem,
                  explanation=excluded.explanation,
                  updated_at=excluded.updated_at
                """,
                (row["id"], stem_text, explanation_text, utc_now()),
            )
            explanation_html = (
                f"<pre>{html.escape(explanation_text)}</pre>"
                if explanation_text
                else "<p class='figure-only'>文字内容已由解析原图替代</p>"
            )
            rendered_assets: dict[str, list[str]] = {
                "question_figure": [],
                "explanation_figure": [],
            }
            for asset in question_assets:
                asset_type = str(asset["asset_type"])
                asset_label = "题目原图" if asset_type == "question_figure" else "解析原图"
                rendered_assets.setdefault(asset_type, []).append(
                    "<figure class='question-asset'>"
                    f"<a href='{relative_uri(review_dir, Path(asset['file_path']))}' target='_blank'>"
                    f"<img loading='lazy' src='{relative_uri(review_dir, Path(asset['file_path']))}' "
                    f"alt='第{html.escape(row['question_no'])}题{asset_label}'></a>"
                    f"<figcaption>{asset_label} · PDF第{asset['source_page']}页</figcaption></figure>"
                )
            question_figure_html = "".join(rendered_assets["question_figure"])
            explanation_figure_html = "".join(rendered_assets["explanation_figure"])
            issue_badge = (
                f"<span class='badge issue'>{html.escape('；'.join(issue_reasons))}</span>"
                if issue_reasons
                else "<span class='badge ok'>字段完整，仍需人工核对</span>"
            )
            question_cards.append(
                f"<article class='question-card{' has-issue' if issue_reasons else ''}' id='{question_id}'>"
                "<header class='question-header'>"
                f"<h3>第{html.escape(row['question_no'])}题</h3>{issue_badge}"
                f"<span class='meta'>{page_label} · OCR置信度 {(row['confidence'] or 0):.3f}</span>"
                "</header>"
                f"<div class='stem'>{html.escape(stem_text)}</div>"
                f"<div class='question-assets'>{question_figure_html}</div>"
                f"<ol class='options'>{option_items}</ol>"
                "<div class='answer-block'>"
                f"<div><h4>答案</h4><p class='answer'>{html.escape(row['answer'] or '未识别')}</p></div>"
                f"<div><h4>答案解析</h4>{explanation_html}</div>"
                "</div>"
                f"<div class='question-assets'>{explanation_figure_html}</div>"
                f"<a class='source-link' href='{relative_uri(review_dir, source_image)}' target='_blank'>"
                f"需要复核时查看{page_label}整页</a>"
                "</article>"
            )
        case_rows = "".join(
            "<tr>"
            f"<td>{html.escape(row['section'] or '')}-{html.escape(row['question_no'])}</td>"
            f"<td>{html.escape(row['stem'][-180:])}</td>"
            f"<td>{'有' if row['explanation'] else '缺少'}</td>"
            f"<td>{row['source_page_from']}</td>"
            f"<td>{(row['confidence'] or 0):.3f}</td>"
            "</tr>"
            for row in case_questions
        )
        page_cards = []
        for row in pages:
            if row["ocr_status"] == "pending":
                continue
            source_image = Path(row["source_image_path"])
            processed_image = Path(row["processed_image_path"])
            page_cards.append(
                "<details class='page'>"
                f"<summary>PDF第{row['pdf_page']}页 · {html.escape(row['page_kind'])} · "
                f"置信度 {(row['ocr_mean_confidence'] or 0):.3f}</summary>"
                "<div class='images'>"
                f"<figure><img loading='lazy' src='{relative_uri(review_dir, source_image)}'><figcaption>原页</figcaption></figure>"
                f"<figure><img loading='lazy' src='{relative_uri(review_dir, processed_image)}'><figcaption>遮罩后</figcaption></figure>"
                "</div>"
                f"<pre>{html.escape(row['ocr_text'] or '')}</pre>"
                "</details>"
            )
        sections.append(
            f"<section><h2>{html.escape(spec.title)}</h2>"
            f"<p>PDF页码：{spec.page_from}-{spec.page_to}；已识别选择题：{len(questions)}；"
            f"案例小问：{len(case_questions)}；缺少选择题号：{html.escape(', '.join(map(str, missing)) or '无')}</p>"
            f"<div class='issue-index'><strong>需要优先核对：</strong>{''.join(issue_links) or '<span>无自动检出的字段缺失</span>'}</div>"
            f"<div class='question-list'>{''.join(question_cards)}</div>"
            "<h3>案例题</h3><table><thead><tr><th>小问</th><th>题干末段</th><th>参考答案</th><th>来源页</th><th>置信度</th></tr></thead>"
            f"<tbody>{case_rows}</tbody></table>"
            "<details class='raw-pages'><summary>高级核对：查看逐页 OCR 和整页原图</summary>"
            f"{''.join(page_cards)}</details></section>"
        )
    content = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>软考真题导入审核</title><style>
body{{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:0;background:#f5f7fb;color:#182230}}
main{{max-width:1280px;margin:auto;padding:32px}}section{{background:white;padding:24px;margin:0 0 24px;border-radius:14px;box-shadow:0 5px 24px #16203312}}
h1,h2,h3{{margin-top:0}}table{{width:100%;border-collapse:collapse;font-size:14px;margin:16px 0 28px}}th,td{{padding:8px;border-bottom:1px solid #e5e9f0;text-align:left;vertical-align:top}}
.issue-index{{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 14px;margin:16px 0;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px}}
.issue-index a{{color:#c2410c;text-decoration:none;background:#ffedd5;padding:4px 8px;border-radius:999px}}
.question-list{{display:grid;gap:14px;margin:18px 0 32px}}.question-card{{border:1px solid #dbe2ea;border-radius:12px;padding:18px;scroll-margin-top:16px}}
.question-card.has-issue{{border:2px solid #f97316;background:#fffaf5}}.question-header{{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px}}
.question-header h3{{margin:0}}.badge{{font-size:12px;padding:3px 8px;border-radius:999px}}.badge.ok{{color:#166534;background:#dcfce7}}.badge.issue{{color:#9a3412;background:#ffedd5}}
.meta{{margin-left:auto;color:#667085;font-size:13px}}.stem{{white-space:pre-wrap;font-weight:650;line-height:1.65;margin-bottom:10px}}
.options{{display:grid;grid-template-columns:1fr 1fr;gap:8px 18px;padding:0;list-style:none}}.option{{padding:9px 11px;background:#f8fafc;border-radius:8px;line-height:1.55}}
.option.missing{{color:#b42318;background:#fef3f2;border:1px dashed #f97066}}.answer-block{{display:grid;grid-template-columns:120px 1fr;gap:14px;margin-top:14px}}
.answer-block>div{{background:#f8fafc;border-radius:9px;padding:12px}}.answer-block h4{{margin:0 0 6px;color:#475467}}.answer{{font-size:22px;font-weight:750;color:#175cd3;margin:0}}
.answer-block pre{{margin:0;padding:0;background:transparent}}.source-link{{display:inline-block;margin-top:12px;color:#475467;font-size:13px}}
.figure-only{{margin:0;color:#667085}}
.question-assets{{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-top:12px}}.question-asset{{margin:0;padding:10px;background:#f8fafc;border-radius:9px}}.question-asset img{{max-height:720px;object-fit:contain;background:white}}
.question-assets:empty{{display:none}}.raw-pages{{margin-top:24px;border-top:1px solid #e5e9f0;padding-top:16px}}
.page{{border:1px solid #dbe2ea;border-radius:10px;margin:10px 0;padding:12px}}summary{{cursor:pointer;font-weight:650}}
.images{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}figure{{margin:12px 0}}img{{width:100%;height:auto;border:1px solid #dbe2ea}}figcaption{{text-align:center;color:#667085}}
pre{{white-space:pre-wrap;background:#f8fafc;padding:14px;border-radius:8px;line-height:1.55}}
@media(max-width:760px){{main{{padding:12px}}.images,.options,.answer-block{{grid-template-columns:1fr}}.meta{{width:100%;margin-left:0}}}}
</style></head><body><main><h1>软考真题导入审核</h1><p>请重点检查题号连续性、答案、图表归属和广告残留。当前报告不调用大模型。</p>{''.join(sections)}</main></body></html>"""
    report_path.write_text(content, encoding="utf-8")
    return report_path


def main() -> int:
    args = parse_args()
    source = args.source.resolve()
    if not source.exists() or source.suffix.lower() != ".pdf":
        raise FileNotFoundError(f"无效 PDF: {source}")
    specs = tuple(paper for paper in PAPERS if not args.papers or paper.slug in args.papers)
    pdftoppm = locate_poppler("pdftoppm", args.pdftoppm)
    pdfinfo = locate_poppler("pdfinfo", args.pdfinfo)
    digest = sha256_file(source)
    page_count = pdf_page_count(pdfinfo, source)
    if page_count < max(paper.page_to for paper in specs):
        raise ValueError(f"PDF只有{page_count}页，无法覆盖预设试卷边界")
    connection = connect_db(args.db.resolve())
    try:
        document_id, stored_source = register_document(
            connection,
            source,
            args.uploads.resolve(),
            digest,
            page_count,
            args.copy_source,
        )
        paper_ids = register_papers(connection, document_id, specs)
        register_masks(connection, document_id, page_count)
        connection.commit()
        pages = selected_pages(specs, args.sample_pages)
        if not args.questions_only:
            process_pages(
                connection,
                document_id,
                stored_source,
                args.assets.resolve(),
                pdftoppm,
                pages,
                specs,
                paper_ids,
                args.dpi,
                args.skip_ocr,
                args.force_render,
            )
        counts = {spec.slug: store_questions(connection, paper_ids[spec.slug]) for spec in specs}
        asset_counts = {
            spec.slug: build_choice_explanation_assets(
                connection, document_id, paper_ids[spec.slug], args.assets.resolve()
            )
            for spec in specs
        }
        apply_seed_corrections(connection, document_id)
        report = build_review_report(
            connection, document_id, args.assets.resolve(), specs, paper_ids
        )
        connection.execute(
            "UPDATE source_documents SET status='pilot_complete', updated_at=? WHERE id=?",
            (utc_now(), document_id),
        )
        connection.commit()
        print(
            json.dumps(
                {
                    "document_id": document_id,
                    "pages": pages,
                    "questions": counts,
                    "question_assets": asset_counts,
                    "report": str(report.resolve()),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"导入失败: {error}", file=sys.stderr)
        raise
