from __future__ import annotations

import os
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

from agent_runtime.search_adapters import officeindex_api as officeindex


ENV_KEYS = [
    "WORKSPACE_FILES_ROOT",
    "OFFICEINDEX_REFRESH_INTERVAL_SECONDS",
    "OFFICEINDEX_BACKGROUND_SYNC_SECONDS",
    "OFFICEINDEX_OPENSEARCH_URL",
    "OFFICEINDEX_OPENSEARCH_USERNAME",
    "OFFICEINDEX_OPENSEARCH_PASSWORD",
]


def _reset_officeindex_state() -> None:
    with officeindex._index_lock:
        officeindex._index_by_path.clear()
        officeindex._last_indexed_at = 0.0
        officeindex._last_refresh_mode = "none"
        officeindex._last_refresh_summary = {}
        officeindex._last_refresh_error = None

    officeindex._background_stop.set()


def _write_ooxml(rel_path: Path, member_path: str, text: str) -> None:
    rel_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(rel_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(member_path, text)


class OfficeIndexAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = Path(tempfile.mkdtemp(prefix="openwork-officeindex-tests-"))
        self.previous_env = {key: os.environ.get(key) for key in ENV_KEYS}

        os.environ["WORKSPACE_FILES_ROOT"] = str(self.temp_dir)
        os.environ["OFFICEINDEX_REFRESH_INTERVAL_SECONDS"] = "0"
        os.environ["OFFICEINDEX_BACKGROUND_SYNC_SECONDS"] = "0"
        os.environ.pop("OFFICEINDEX_OPENSEARCH_URL", None)
        os.environ.pop("OFFICEINDEX_OPENSEARCH_USERNAME", None)
        os.environ.pop("OFFICEINDEX_OPENSEARCH_PASSWORD", None)

        _reset_officeindex_state()

    def tearDown(self) -> None:
        _reset_officeindex_state()
        shutil.rmtree(self.temp_dir, ignore_errors=True)

        for key, value in self.previous_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _create_docx(self, relative_path: str, text: str) -> None:
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            "<w:body><w:p><w:r><w:t>"
            f"{escape(text)}"
            "</w:t></w:r></w:p></w:body></w:document>"
        )
        _write_ooxml(self.temp_dir / relative_path, "word/document.xml", xml)

    def _create_pptx(self, relative_path: str, text: str) -> None:
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
            'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            "<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>"
            f"{escape(text)}"
            "</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"
        )
        _write_ooxml(self.temp_dir / relative_path, "ppt/slides/slide1.xml", xml)

    def _create_xlsx(self, relative_path: str, text: str) -> None:
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            "<si><t>"
            f"{escape(text)}"
            "</t></si></sst>"
        )
        _write_ooxml(self.temp_dir / relative_path, "xl/sharedStrings.xml", xml)

    def test_ooxml_fixture_content_hits(self) -> None:
        doc_query = "nebula docx launch marker"
        ppt_query = "aurora pptx storyline marker"
        xlsx_query = "orion xlsx budget marker"

        self._create_docx("docs/roadmap.docx", doc_query)
        self._create_pptx("slides/launch.pptx", ppt_query)
        self._create_xlsx("sheets/budget.xlsx", xlsx_query)

        summary = officeindex.reindex(officeindex.OfficeReindexRequest(mode="full"))
        self.assertEqual(summary["status"], "ok")
        self.assertGreaterEqual(summary["indexedFiles"], 3)

        for query, expected_file_path in [
            (doc_query, "docs/roadmap.docx"),
            (ppt_query, "slides/launch.pptx"),
            (xlsx_query, "sheets/budget.xlsx"),
        ]:
            payload = officeindex.search(officeindex.OfficeSearchRequest(query=query, limit=5))
            matches = [result for result in payload["results"] if result["filePath"] == expected_file_path]
            self.assertTrue(matches, f"Expected {expected_file_path} for query {query!r}")
            snippet = (matches[0].get("snippet") or "").lower()
            self.assertIn(query.lower(), snippet)

    def test_rank_tuning_filename_exact_before_content_exact_before_partial(self) -> None:
        self._create_docx("alpha plan.docx", "unrelated payload")
        self._create_docx("content-exact.docx", "alpha plan")
        self._create_docx("content-partial.docx", "alpha planning checklist")

        summary = officeindex.reindex(officeindex.OfficeReindexRequest(mode="full"))
        self.assertEqual(summary["status"], "ok")

        payload = officeindex.search(officeindex.OfficeSearchRequest(query="alpha plan", limit=10))
        results_by_path = {result["filePath"]: result for result in payload["results"]}
        ordered_paths = [result["filePath"] for result in payload["results"]]

        filename_exact = "alpha plan.docx"
        content_exact = "content-exact.docx"
        content_partial = "content-partial.docx"

        self.assertIn(filename_exact, ordered_paths)
        self.assertIn(content_exact, ordered_paths)
        self.assertIn(content_partial, ordered_paths)

        self.assertLess(ordered_paths.index(filename_exact), ordered_paths.index(content_exact))
        self.assertLess(ordered_paths.index(content_exact), ordered_paths.index(content_partial))

        self.assertEqual(results_by_path[filename_exact]["sourceMeta"]["matchKind"], "filename-exact")
        self.assertEqual(results_by_path[content_exact]["sourceMeta"]["matchKind"], "content-exact-phrase")
        self.assertEqual(results_by_path[content_partial]["sourceMeta"]["matchKind"], "content-partial")


if __name__ == "__main__":
    unittest.main()
