from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from statistics import mean
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = ROOT / "data" / "exam-content.sqlite"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="检查扫描真题导入完整性")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--output", type=Path, help="将检查结果写入 JSON")
    parser.add_argument("--strict", action="store_true", help="发现缺题或异常时返回失败")
    return parser.parse_args()


def validate(db_path: Path) -> dict[str, Any]:
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    papers: list[dict[str, Any]] = []
    try:
        paper_rows = connection.execute(
            "SELECT * FROM exam_papers ORDER BY pdf_page_from"
        ).fetchall()
        for paper in paper_rows:
            pages = connection.execute(
                "SELECT * FROM exam_pages WHERE paper_id=? ORDER BY pdf_page",
                (paper["id"],),
            ).fetchall()
            questions = connection.execute(
                """
                SELECT q.question_no,
                       COALESCE(c.stem, q.stem) AS stem,
                       COALESCE(c.options_json, q.options_json) AS options_json,
                       COALESCE(c.answer, q.answer) AS answer,
                       COALESCE(c.explanation, q.explanation) AS explanation,
                       q.source_page_from, q.source_page_to
                FROM exam_questions q
                LEFT JOIN question_corrections c ON c.question_id=q.id
                WHERE q.paper_id=? AND q.question_type='choice'
                ORDER BY CAST(q.question_no AS INTEGER)
                """,
                (paper["id"],),
            ).fetchall()
            case_questions = connection.execute(
                """
                SELECT q.section, q.question_no,
                       COALESCE(c.explanation, q.explanation) AS explanation
                FROM exam_questions q
                LEFT JOIN question_corrections c ON c.question_id=q.id
                WHERE q.paper_id=? AND q.question_type='case'
                ORDER BY q.section, CAST(q.question_no AS INTEGER)
                """,
                (paper["id"],),
            ).fetchall()
            found = {int(question["question_no"]) for question in questions}
            anomalies: list[dict[str, Any]] = []
            for question in questions:
                options = json.loads(question["options_json"])
                reasons: list[str] = []
                if len(options) != 4:
                    reasons.append(f"选项数={len(options)}")
                if not question["answer"]:
                    reasons.append("答案为空")
                if question["source_page_to"] - question["source_page_from"] > 1:
                    reasons.append("跨页超过2页")
                if not question["stem"].strip():
                    reasons.append("题干为空")
                if reasons:
                    anomalies.append(
                        {
                            "question_no": int(question["question_no"]),
                            "source_page_from": question["source_page_from"],
                            "source_page_to": question["source_page_to"],
                            "reasons": reasons,
                        }
                    )
            confidences = [
                float(page["ocr_mean_confidence"])
                for page in pages
                if page["ocr_mean_confidence"] is not None
            ]
            combined_ocr = "\n".join(page["ocr_text"] or "" for page in pages)
            ad_terms = {
                term: combined_ocr.count(term)
                for term in ("51kpm", "QQ/VX", "扫码", "关注")
                if term in combined_ocr
            }
            expected_pages = paper["pdf_page_to"] - paper["pdf_page_from"] + 1
            papers.append(
                {
                    "paper_id": paper["id"],
                    "title": paper["title"],
                    "page_range": [paper["pdf_page_from"], paper["pdf_page_to"]],
                    "expected_pages": expected_pages,
                    "registered_pages": len(pages),
                    "ocr_complete_pages": sum(page["ocr_status"] == "complete" for page in pages),
                    "mean_ocr_confidence": round(mean(confidences), 4) if confidences else 0.0,
                    "choice_question_count": len(questions),
                    "missing_choice_numbers": [number for number in range(1, 76) if number not in found],
                    "question_anomalies": anomalies,
                    "case_question_count": len(case_questions),
                    "case_sections": sorted({question["section"] for question in case_questions}),
                    "case_questions_missing_answer": [
                        f"{question['section']}-{question['question_no']}"
                        for question in case_questions
                        if not question["explanation"]
                    ],
                    "remaining_ad_terms": ad_terms,
                }
            )
    finally:
        connection.close()
    failed = any(
        paper["registered_pages"] != paper["expected_pages"]
        or paper["ocr_complete_pages"] != paper["expected_pages"]
        or paper["missing_choice_numbers"]
        or paper["question_anomalies"]
        or not paper["case_question_count"]
        or paper["case_questions_missing_answer"]
        for paper in papers
    )
    return {"database": str(db_path.resolve()), "passed": not failed, "papers": papers}


def main() -> int:
    args = parse_args()
    result = validate(args.db.resolve())
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
        print(args.output.resolve())
    else:
        print(rendered)
    return 1 if args.strict and not result["passed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
