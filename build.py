#!/usr/bin/env python3
"""일검풍운결 세이브 에디터 v1.0 오프라인 단일 HTML 및 Windows WebView2 실행 파일 빌드 스크립트."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from typing import Iterable, Optional

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")
DIST = os.path.join(ROOT, "dist")

HTML_IN = os.path.join(SRC, "editor-page.html")
HTML_OUT = os.path.join(DIST, "WanderingSwordSaveEditor-v1.0.html")
EXE_OUT = os.path.join(DIST, "WanderingSwordSaveEditor-v1.0.exe")

SCRIPT_ORDER = ("catalog-data.js", "gvas-codec.js", "editor-core.js", "editor-ui.js")

BUNDLE_START = "<!-- BUNDLE_SCRIPTS_START -->"
BUNDLE_END = "<!-- BUNDLE_SCRIPTS_END -->"

EXTERNAL_REF_RE = re.compile(
    r'(?i)\b(?:https?|ftp|wss?)://'
    r'|\b(?:src|href|action|poster|data|cite)\s*=\s*["\']?\s*//'
    r'|\burl\(\s*["\']?\s*(?:https?|ftp|wss?)?//'
)
HANZI_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]")
MARKUP_TAG_RE = re.compile(r"<(?:R|G|Y|B|W|O|P)>|</>")

MAX_HTML_SIZE = 10 * 1024 * 1024

CSC = "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
FRAMEWORK_DIR = os.path.dirname(CSC)


def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def _write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def _matches_pattern(pattern: re.Pattern[str], text: str) -> bool:
    return isinstance(text, str) and pattern.search(text) is not None


def has_external_url_ref(text: str) -> bool:
    return _matches_pattern(EXTERNAL_REF_RE, text)


def has_hanzi(text: str) -> bool:
    return _matches_pattern(HANZI_RE, text)


def has_markup_tags(text: str) -> bool:
    return _matches_pattern(MARKUP_TAG_RE, text)


def _escape_script_closers(js: str) -> str:
    return re.sub(
        r"</(script)",
        lambda m: "<\\/" + m.group(1),
        js,
        flags=re.IGNORECASE,
    )


def _inline_scripts() -> str:
    blocks = []
    for script_name in SCRIPT_ORDER:
        script_path = os.path.join(SRC, script_name)
        if not os.path.isfile(script_path):
            raise FileNotFoundError(f"필수 스크립트 파일이 없습니다: {script_path}")
        js = _read_text(script_path)
        js = _escape_script_closers(js)
        blocks.append(f"<script>\n{js}\n</script>")
    return "\n".join(blocks)


def _replace_bundle_block(html: str, replacement: str) -> str:
    start_count = html.count(BUNDLE_START)
    end_count = html.count(BUNDLE_END)
    if start_count != 1 or end_count != 1:
        raise ValueError(
            f"번들 구분 주석이 정확히 1쌍이어야 합니다 (start={start_count}, end={end_count})."
        )
    start = html.index(BUNDLE_START)
    end = html.index(BUNDLE_END, start) + len(BUNDLE_END)
    return html[:start] + replacement + html[end:]


def _validate_html(out_html: str) -> None:
    if has_external_url_ref(out_html):
        raise ValueError("번들된 HTML에 외부 URL 참조가 포함되어 있습니다.")
    if has_hanzi(out_html):
        raise ValueError("번들된 HTML에 한자(CJK) 문자가 포함되어 있습니다.")
    if has_markup_tags(out_html):
        raise ValueError("번들된 HTML에 잔존 마크업 태그(<R>/<G>/<Y></>)가 포함되어 있습니다.")
    if len(out_html.encode("utf-8")) >= MAX_HTML_SIZE:
        raise ValueError("번들된 HTML 크기가 10 MiB 제한을 초과했습니다.")


def build_html() -> str:
    if not os.path.isfile(HTML_IN):
        raise FileNotFoundError(f"HTML 템플릿 파일이 없습니다: {HTML_IN}")

    html = _read_text(HTML_IN)
    bundled = _replace_bundle_block(html, _inline_scripts())
    _validate_html(bundled)
    _write_text(HTML_OUT, bundled)
    print(f"오프라인 단일 HTML 생성 완료: {HTML_OUT}")
    return bundled


def _find_first_file(base: str, candidates: Iterable[str]) -> Optional[str]:
    for rel in candidates:
        path = os.path.join(base, rel)
        if os.path.isfile(path):
            return path
    return None


def _find_webview2_file(webview2_dir: str, filename: str) -> str:
    candidates = {
        "WebView2Loader.dll": (
            "WebView2Loader.dll",
            os.path.join("runtimes", "win-x64", "native", "WebView2Loader.dll"),
            os.path.join("build", "native", "x64", "WebView2Loader.dll"),
        ),
        "Microsoft.Web.WebView2.Core.dll": (
            "Microsoft.Web.WebView2.Core.dll",
            os.path.join("lib", "net462", "Microsoft.Web.WebView2.Core.dll"),
            os.path.join("lib", "net45", "Microsoft.Web.WebView2.Core.dll"),
        ),
        "Microsoft.Web.WebView2.WinForms.dll": (
            "Microsoft.Web.WebView2.WinForms.dll",
            os.path.join("lib", "net462", "Microsoft.Web.WebView2.WinForms.dll"),
            os.path.join("lib", "net45", "Microsoft.Web.WebView2.WinForms.dll"),
        ),
        "LICENSE.txt": ("LICENSE.txt",),
    }.get(filename, (filename,))

    found = _find_first_file(webview2_dir, candidates)
    if found:
        return found

    for dirpath, _dirnames, filenames in os.walk(webview2_dir):
        if filename in filenames:
            return os.path.join(dirpath, filename)

    raise FileNotFoundError(f"WebView2 SDK 파일을 찾을 수 없습니다 ({filename}): {webview2_dir}")


def _require_file(path: str, label: str) -> str:
    if not os.path.isfile(path):
        raise FileNotFoundError(f"필수 파일이 없습니다 ({label}): {path}")
    return path


def _resource_arg(path: str, resource_name: str) -> str:
    return f"/resource:{path},{resource_name}"


def build_exe(webview2_dir: str) -> str:
    csc_path = _require_file(CSC, "csc.exe")
    webview2_dir = os.path.abspath(webview2_dir)
    if not os.path.isdir(webview2_dir):
        raise NotADirectoryError(f"WebView2 SDK 폴더가 없습니다: {webview2_dir}")

    core_dll = _find_webview2_file(webview2_dir, "Microsoft.Web.WebView2.Core.dll")
    winforms_dll = _find_webview2_file(webview2_dir, "Microsoft.Web.WebView2.WinForms.dll")
    loader_dll = _find_webview2_file(webview2_dir, "WebView2Loader.dll")
    license_txt = _find_webview2_file(webview2_dir, "LICENSE.txt")

    if not os.path.isfile(HTML_OUT):
        build_html()

    save_store_cs = _require_file(os.path.join(SRC, "SaveStore.cs"), "SaveStore.cs")
    save_editor_cs = _require_file(os.path.join(SRC, "SaveEditor.cs"), "SaveEditor.cs")
    editor_html = _require_file(HTML_OUT, "editor.html")

    system_windows_forms = _require_file(
        os.path.join(FRAMEWORK_DIR, "System.Windows.Forms.dll"),
        "System.Windows.Forms.dll",
    )
    system_drawing = _require_file(
        os.path.join(FRAMEWORK_DIR, "System.Drawing.dll"),
        "System.Drawing.dll",
    )
    system_web_extensions = _require_file(
        os.path.join(FRAMEWORK_DIR, "System.Web.Extensions.dll"),
        "System.Web.Extensions.dll",
    )

    os.makedirs(DIST, exist_ok=True)

    cmd = [
        csc_path,
        "/nologo",
        "/target:winexe",
        "/platform:x64",
        "/optimize+",
        "/debug-",
        f"/out:{EXE_OUT}",
        f"/reference:{system_windows_forms}",
        f"/reference:{system_drawing}",
        f"/reference:{system_web_extensions}",
        f"/reference:{core_dll}",
        f"/reference:{winforms_dll}",
        _resource_arg(core_dll, "Microsoft.Web.WebView2.Core.dll"),
        _resource_arg(winforms_dll, "Microsoft.Web.WebView2.WinForms.dll"),
        _resource_arg(loader_dll, "WebView2Loader.dll"),
        _resource_arg(license_txt, "WebView2-LICENSE.txt"),
        _resource_arg(editor_html, "editor.html"),
        save_store_cs,
        save_editor_cs,
    ]

    subprocess.run(cmd, cwd=ROOT, check=True)
    if not os.path.isfile(EXE_OUT):
        raise RuntimeError(f"실행 파일이 생성되지 않았습니다: {EXE_OUT}")
    print(f"Windows 실행 파일 생성 완료: {EXE_OUT}")
    return EXE_OUT


def parse_args(argv: Optional[Iterable[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="일검풍운결 세이브 에디터 v1.0 빌드 스크립트"
    )
    parser.add_argument(
        "--exe",
        action="store_true",
        help="단일 HTML 번들 생성 후 Windows WebView2 실행 파일(.exe)을 함께 컴파일합니다.",
    )
    parser.add_argument(
        "--webview2",
        metavar="DIR",
        help="Microsoft.Web.WebView2 SDK 폴더 경로",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Iterable[str]] = None) -> int:
    args = parse_args(argv)
    try:
        build_html()
        if args.exe:
            if not args.webview2:
                raise ValueError("--exe 옵션에는 --webview2 <폴더경로>가 필요합니다.")
            build_exe(args.webview2)
    except Exception as exc:
        print(f"빌드 오류: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
