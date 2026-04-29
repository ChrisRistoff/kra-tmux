#!/usr/bin/env python3
"""
kra_docs_worker.py — Crawl4AI wrapper used by the docs coordinator.

Spawned by the Node coordinator (one process per source). Streams JSON Lines
to stdout; the coordinator reads stdout line-by-line. The schema mirrors the
DocsWorkerMessage discriminated union in src/AI/AIAgent/shared/docs/types.ts.

Each line on stdout is a single JSON object with a `type` field:
    worker-ready     {alias, pid}
    page-fetched     {alias, url, title, markdown, links[], hash, etag?, lastModified?}
    page-unchanged   {alias, url, pageHash, etag?, lastModified?}
    page-skipped     {alias, url, reason}
    worker-progress  {alias, pagesDone, pagesTotal, currentUrl}
    worker-error     {alias, url?, error, fatal}
    source-done      {alias, summary: {pagesScraped, pagesSkipped, chunksWritten, elapsedMs}}

stdin: a single JSON line `{knownPages: {<url>: {etag?, lastModified?, pageHash, lastIndexedAt, chunkCount}}, bypassIncremental: bool}`.
The coordinator writes that and closes stdin before any output is expected.

stderr is reserved for human-readable diagnostics; the coordinator merely logs
it. Anything written to stdout MUST be valid JSONL — no banner prints.

Incremental strategy (3 layers):
  1. Sitemap discovery: try <base>/sitemap.xml and /sitemap_index.xml, parse
     <lastmod>. If the sitemap lastmod is older than knownPages[url].lastIndexedAt,
     emit page-skipped(reason=sitemap-unchanged).
  2. Conditional GET: send If-None-Match / If-Modified-Since when we have
     them; on 304 emit page-skipped(reason=http-not-modified).
  3. Content hash: after fetching markdown via crawl4ai, compare sha256 against
     knownPages[url].pageHash; on match emit page-unchanged.

Falls back to BFSDeepCrawlStrategy when no sitemap is available.
"""

from __future__ import annotations

import argparse
import asyncio
import re
import hashlib
import json
import os
import sys
import time
from typing import Any
from urllib.parse import urljoin, urlparse
from xml.etree import ElementTree as ET


def _build_ssl_context() -> Any:
    """Build an SSL context that trusts both certifi's CA bundle AND the
    OS trust store. The OS-trust path is critical for users behind a
    TLS-intercepting corporate proxy (e.g. Zscaler/Netskope) whose CA only
    lives in the system keychain. Falls back gracefully on any failure."""
    try:
        import ssl
        try:
            import truststore
            return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        except Exception:  # noqa: BLE001
            import certifi
            return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # noqa: BLE001
        return True


_SSL_CTX: Any = _build_ssl_context()

def emit(msg: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


_GLOB_CACHE: dict[str, "re.Pattern[str]"] = {}

def _glob_to_regex(pattern: str) -> "re.Pattern[str]":
    """Compile a globstar pattern to a regex.

    Semantics (URL-aware, matches what users expect from `**`):
      `**` matches any sequence of characters (including `/`).
      `*`  matches any sequence of characters except `/`.
      `?`  matches exactly one character (any).
      All other characters are literal.

    Anchored at both ends (full match).
    """
    cached = _GLOB_CACHE.get(pattern)
    if cached is not None:
        return cached
    out: list[str] = []
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c == "*":
            if i + 1 < len(pattern) and pattern[i + 1] == "*":
                out.append(".*")
                i += 2
                continue
            out.append("[^/]*")
            i += 1
            continue
        if c == "?":
            out.append(".")
            i += 1
            continue
        out.append(re.escape(c))
        i += 1
    compiled = re.compile("^" + "".join(out) + "$")
    _GLOB_CACHE[pattern] = compiled
    return compiled

def url_matches(url: str, patterns: list[str]) -> bool:
    if not patterns:
        return True
    return any(_glob_to_regex(p).match(url) is not None for p in patterns)


def stable_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def read_stdin_payload() -> dict[str, Any]:
    """Read the single-line JSON payload the coordinator writes to our stdin.
    Returns an empty default if anything is missing/unparseable.
    """
    try:
        raw = sys.stdin.readline()
        if not raw.strip():
            return {"knownPages": {}, "bypassIncremental": False}
        data = json.loads(raw)
        if not isinstance(data, dict):
            return {"knownPages": {}, "bypassIncremental": False}
        data.setdefault("knownPages", {})
        data.setdefault("bypassIncremental", False)
        return data
    except Exception as exc:  # noqa: BLE001
        print(f"docs-worker: stdin parse failed: {exc}", file=sys.stderr)
        return {"knownPages": {}, "bypassIncremental": False}


def parse_iso_to_epoch(s: str) -> float | None:
    try:
        from datetime import datetime
        # Accept e.g. "2024-09-30", "2024-09-30T12:00:00+00:00", with/without Z.
        s = s.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s).timestamp()
    except Exception:  # noqa: BLE001
        return None


async def discover_sitemap_urls(base_url: str) -> list[tuple[str, float | None]]:
    """Return [(url, lastmod_epoch_or_None), ...] from a sitemap discovered
    at the URL's directory or any ancestor directory (and finally the host
    root). Empty list if no sitemap was found.

    AWS-style docs publish a per-product sitemap at e.g.
    `<host>/lambda/latest/dg/sitemap.xml` rather than at the host root, so we
    try the most-specific path first and walk up."""
    try:
        import httpx
    except Exception:
        return []

    parsed = urlparse(base_url)
    base_root = f"{parsed.scheme}://{parsed.netloc}"
    # Build a list of directories to probe: most-specific first, then ancestors,
    # then host root. Strip the trailing filename if any.
    path = parsed.path or "/"
    if not path.endswith("/"):
        path = path.rsplit("/", 1)[0] + "/"
    dirs: list[str] = []
    while True:
        if path not in dirs:
            dirs.append(path)
        if path == "/":
            break
        path = path.rstrip("/").rsplit("/", 1)[0] + "/"
        if not path:
            path = "/"
    candidates: list[str] = []
    for d in dirs:
        candidates.append(f"{base_root}{d}sitemap.xml")
        candidates.append(f"{base_root}{d}sitemap_index.xml")

    headers = {"User-Agent": "kra-docs-crawler/1.0"}
    found: dict[str, float | None] = {}

    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True, headers=headers, verify=_SSL_CTX) as client:
        for sm_url in candidates:
            try:
                r = await client.get(sm_url)
                if r.status_code != 200 or not r.text.strip():
                    continue
                # Cheap guard: many 404 pages return 200 with HTML. Require XML.
                head = r.text.lstrip()[:200].lower()
                if "<?xml" not in head and "<urlset" not in head and "<sitemapindex" not in head:
                    continue
                await _parse_sitemap_into(client, r.text, found, sm_url)
                if found:
                    break
            except Exception:  # noqa: BLE001
                continue

    return [(u, lm) for u, lm in found.items()]


async def _parse_sitemap_into(
    client: Any,
    xml_text: str,
    out: dict[str, float | None],
    src_url: str,
) -> None:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return

    tag = root.tag.lower()
    ns = ""
    if "}" in root.tag:
        ns = root.tag.split("}", 1)[0] + "}"

    if tag.endswith("sitemapindex"):
        for sm in root.findall(f"{ns}sitemap"):
            loc_el = sm.find(f"{ns}loc")
            if loc_el is None or not (loc_el.text or "").strip():
                continue
            sub_url = loc_el.text.strip()
            try:
                rr = await client.get(sub_url)
                if rr.status_code == 200 and rr.text.strip():
                    await _parse_sitemap_into(client, rr.text, out, sub_url)
            except Exception:  # noqa: BLE001
                continue
        return

    if tag.endswith("urlset"):
        for url_el in root.findall(f"{ns}url"):
            loc_el = url_el.find(f"{ns}loc")
            if loc_el is None or not (loc_el.text or "").strip():
                continue
            url = loc_el.text.strip()
            lastmod_el = url_el.find(f"{ns}lastmod")
            lm: float | None = None
            if lastmod_el is not None and lastmod_el.text:
                lm = parse_iso_to_epoch(lastmod_el.text)
            out[url] = lm


async def conditional_fetch(
    client: Any,
    url: str,
    known: dict[str, Any] | None,
) -> tuple[int, str | None, str | None, str | None]:
    """Try a conditional GET; return (status, etag, last_modified, body_or_None).
    Body is None on 304. status=0 means a network error."""
    headers: dict[str, str] = {"User-Agent": "kra-docs-crawler/1.0"}
    if known:
        if known.get("etag"):
            headers["If-None-Match"] = known["etag"]
        if known.get("lastModified"):
            headers["If-Modified-Since"] = known["lastModified"]
    try:
        r = await client.get(url, headers=headers)
    except Exception:  # noqa: BLE001
        return (0, None, None, None)
    etag = r.headers.get("etag") or r.headers.get("ETag")
    last_modified = r.headers.get("last-modified") or r.headers.get("Last-Modified")
    if r.status_code == 304:
        return (304, etag, last_modified, None)
    if r.status_code != 200:
        return (r.status_code, etag, last_modified, None)
    return (200, etag, last_modified, r.text)


def extract_markdown(result: Any) -> str:
    md_obj = getattr(result, "markdown", None)
    if md_obj is None:
        return ""
    return (
        getattr(md_obj, "fit_markdown", None)
        or getattr(md_obj, "raw_markdown", None)
        or str(md_obj)
        or ""
    )


def extract_title(result: Any) -> str:
    meta = getattr(result, "metadata", None) or {}
    if isinstance(meta, dict):
        return meta.get("title") or ""
    return ""


def extract_internal_links(result: Any) -> list[str]:
    links_block = getattr(result, "links", None) or {}
    internal = links_block.get("internal", []) if isinstance(links_block, dict) else []
    out: list[str] = []
    for link in internal:
        if isinstance(link, dict) and link.get("href"):
            out.append(link["href"])
        elif isinstance(link, str):
            out.append(link)
    return out


async def decide_mode_via_probe(probe_url: str, timeout: float = 10.0) -> tuple[str, str]:
    """Returns ('http' | 'browser', reason_str). Strategy: HTTP-GET the probe
    URL, strip <script>/<style>, count remaining text length. If >= 2 KB of
    text the page is server-rendered enough to skip Chromium; otherwise we
    assume it needs JS execution and fall back to a real browser."""
    import re
    try:
        import httpx
    except Exception as exc:  # noqa: BLE001
        return ("browser", f"probe_import_failed: {exc}")
    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            headers={"User-Agent": "kra-docs-crawler/1.0"},
            verify=_SSL_CTX,
        ) as client:
            r = await client.get(probe_url)
            if r.status_code != 200:
                return ("browser", f"probe_http_status={r.status_code}")
            html = r.text or ""
    except Exception as exc:  # noqa: BLE001
        return ("browser", f"probe_failed: {type(exc).__name__}: {exc}")
    stripped = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html, flags=re.DOTALL | re.IGNORECASE)
    stripped = re.sub(r"<[^>]+>", " ", stripped)
    text_len = len(re.sub(r"\s+", " ", stripped).strip())
    if text_len >= 2048:
        return ("http", f"probe_text_chars={text_len}")
    return ("browser", f"probe_text_chars={text_len}_below_threshold")


def build_crawler_kwargs(mode: str, BrowserConfig: Any, AsyncHTTPCrawlerStrategy: Any, HTTPCrawlerConfig: Any) -> dict[str, Any]:
    """Constructor kwargs for AsyncWebCrawler depending on mode."""
    if mode == "http":
        http_cfg = HTTPCrawlerConfig(
            method="GET",
            headers={"User-Agent": "kra-docs-crawler/1.0"},
            follow_redirects=True,
            verify_ssl=_SSL_CTX,
        )
        return {"crawler_strategy": AsyncHTTPCrawlerStrategy(browser_config=http_cfg, max_connections=32)}
    return {"config": BrowserConfig(headless=True, verbose=False)}


async def fetch_response_headers(http_client: Any, url: str) -> tuple[str | None, str | None]:
    try:
        resp = await http_client.head(url)
        etag = resp.headers.get("etag") or resp.headers.get("ETag")
        last_modified = resp.headers.get("last-modified") or resp.headers.get("Last-Modified")
        return (etag, last_modified)
    except Exception:  # noqa: BLE001
        return (None, None)


async def crawl_single_page(crawler: Any, url: str, run_cfg: Any) -> Any:
    """Crawl exactly one URL via crawl4ai (no deep crawl)."""
    try:
        async for result in await crawler.arun(url=url, config=run_cfg):
            return result
    except Exception as exc:  # noqa: BLE001
        raise exc
    return None


async def crawl(args: argparse.Namespace, payload: dict[str, Any]) -> int:
    try:
        from crawl4ai import (
            AsyncWebCrawler,
            BrowserConfig,
            CacheMode,
            CrawlerRunConfig,
            HTTPCrawlerConfig,
            MemoryAdaptiveDispatcher,
            RateLimiter,
        )
        from crawl4ai.async_crawler_strategy import AsyncHTTPCrawlerStrategy
        from crawl4ai.content_filter_strategy import PruningContentFilter
        from crawl4ai.deep_crawling import BFSDeepCrawlStrategy
        from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
    except Exception as exc:  # noqa: BLE001
        emit({
            "type": "worker-error",
            "alias": args.alias,
            "error": f"crawl4ai import failed: {exc}",
            "fatal": True,
        })
        return 2

    include_patterns: list[str] = args.include or []
    exclude_patterns: list[str] = args.exclude or []
    known_pages: dict[str, dict[str, Any]] = payload.get("knownPages", {}) or {}
    bypass = bool(payload.get("bypassIncremental", False))

    started = time.time()
    pages_scraped = 0
    pages_skipped = 0

    requested_mode = (args.mode or "auto").lower()
    if requested_mode not in ("auto", "http", "browser"):
        requested_mode = "auto"
    if requested_mode == "auto":
        decided_mode, decision_reason = await decide_mode_via_probe(args.url)
    else:
        decided_mode, decision_reason = (requested_mode, "explicit")

    crawler_kwargs = build_crawler_kwargs(
        decided_mode, BrowserConfig, AsyncHTTPCrawlerStrategy, HTTPCrawlerConfig,
    )
    md_generator = DefaultMarkdownGenerator(
        content_filter=PruningContentFilter(threshold=0.45, threshold_type="dynamic"),
    )

    default_concurrency = 8 if decided_mode == "http" else 4
    concurrency = max(1, int(args.concurrency or default_concurrency))
    dispatcher = MemoryAdaptiveDispatcher(
        max_session_permit=concurrency,
        rate_limiter=RateLimiter(base_delay=(0.1, 0.4), max_delay=10.0, max_retries=2),
    )

    emit({"type": "worker-ready", "alias": args.alias, "pid": os.getpid()})
    emit({
        "type": "mode-decided",
        "alias": args.alias,
        "mode": decided_mode,
        "reason": decision_reason,
    })

    # ----- Phase 1: try the sitemap-first path -----
    sitemap_entries: list[tuple[str, float | None]] = []
    if args.max_depth > 0:
        try:
            sitemap_entries = await discover_sitemap_urls(args.url)
        except Exception as exc:  # noqa: BLE001
            print(f"docs-worker: sitemap discovery error: {exc}", file=sys.stderr)
            sitemap_entries = []

    use_sitemap = len(sitemap_entries) > 0

    # Filter sitemap urls by include/exclude + max_pages
    if use_sitemap:
        filtered: list[tuple[str, float | None]] = []
        for u, lm in sitemap_entries:
            if not url_matches(u, include_patterns):
                continue
            if exclude_patterns and url_matches(u, exclude_patterns):
                continue
            filtered.append((u, lm))
        sitemap_entries = filtered[: args.max_pages]
        pages_total = max(1, len(sitemap_entries))
    else:
        pages_total = max(1, args.max_pages)

    run_cfg_single = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        markdown_generator=md_generator,
        verbose=False,
        stream=True,
        wait_until="domcontentloaded",
        page_timeout=int(args.page_timeout_ms),
    )

    try:
        if use_sitemap:
            try:
                import httpx
            except Exception as exc:  # noqa: BLE001
                emit({
                    "type": "worker-error",
                    "alias": args.alias,
                    "error": f"httpx import failed: {exc}",
                    "fatal": True,
                })
                return 2

            # Pass 1: pre-filter via sitemap-lastmod and conditional GET.
            to_render: list[str] = []
            async with httpx.AsyncClient(timeout=30.0, follow_redirects=True, verify=_SSL_CTX) as http_client:
                for url, sm_lastmod in sitemap_entries:
                    if pages_scraped + pages_skipped + len(to_render) >= args.max_pages:
                        break
                    known = None if bypass else known_pages.get(url)
                    if known and sm_lastmod is not None:
                        last_indexed = (known.get("lastIndexedAt") or 0) / 1000.0
                        if last_indexed > 0 and sm_lastmod <= last_indexed:
                            emit({"type": "page-skipped", "alias": args.alias, "url": url, "reason": "sitemap-unchanged"})
                            pages_skipped += 1
                            emit_progress(args.alias, pages_scraped + pages_skipped, pages_total, url)
                            continue
                    if known:
                        status, _et, _lm, _ = await conditional_fetch(http_client, url, known)
                        if status == 304:
                            emit({"type": "page-skipped", "alias": args.alias, "url": url, "reason": "http-not-modified"})
                            pages_skipped += 1
                            emit_progress(args.alias, pages_scraped + pages_skipped, pages_total, url)
                            continue
                    to_render.append(url)

                # Pass 2: parallel render via arun_many + dispatcher.
                if to_render:
                    async with AsyncWebCrawler(**crawler_kwargs) as crawler:
                        async for result in await crawler.arun_many(to_render, config=run_cfg_single, dispatcher=dispatcher):
                            url = getattr(result, "url", None) or ""
                            if not getattr(result, "success", False):
                                emit({
                                    "type": "worker-error",
                                    "alias": args.alias,
                                    "url": url,
                                    "error": getattr(result, "error_message", "unknown") or "unknown",
                                    "fatal": False,
                                })
                                continue
                            markdown = extract_markdown(result)
                            if not markdown.strip():
                                continue
                            ph = stable_hash(markdown)
                            etag2, last_modified2 = await fetch_response_headers(http_client, url)
                            known = None if bypass else known_pages.get(url)
                            if known and known.get("pageHash") == ph:
                                payload_msg: dict[str, Any] = {
                                    "type": "page-unchanged",
                                    "alias": args.alias,
                                    "url": url,
                                    "pageHash": ph,
                                }
                                if etag2:
                                    payload_msg["etag"] = etag2
                                if last_modified2:
                                    payload_msg["lastModified"] = last_modified2
                                emit(payload_msg)
                                pages_skipped += 1
                                emit_progress(args.alias, pages_scraped + pages_skipped, pages_total, url)
                                continue
                            page_msg: dict[str, Any] = {
                                "type": "page-fetched",
                                "alias": args.alias,
                                "url": url,
                                "title": extract_title(result),
                                "markdown": markdown,
                                "links": extract_internal_links(result),
                                "hash": ph,
                            }
                            if etag2:
                                page_msg["etag"] = etag2
                            if last_modified2:
                                page_msg["lastModified"] = last_modified2
                            emit(page_msg)
                            pages_scraped += 1
                            emit_progress(args.alias, pages_scraped + pages_skipped, pages_total, url)
        else:
            # ----- Fallback: BFSDeepCrawl (or single-page when max_depth==0) -----
            deep_crawl = None
            if args.max_depth > 0:
                deep_crawl = BFSDeepCrawlStrategy(
                    max_depth=args.max_depth,
                    max_pages=args.max_pages,
                    include_external=False,
                )
            run_cfg = CrawlerRunConfig(
                cache_mode=CacheMode.BYPASS,
                markdown_generator=md_generator,
                deep_crawl_strategy=deep_crawl,
                verbose=False,
                stream=True,
                wait_until="domcontentloaded",
                page_timeout=int(args.page_timeout_ms),
            )
            async with AsyncWebCrawler(**crawler_kwargs) as crawler:
                arun_ret = await crawler.arun(url=args.url, config=run_cfg)
                # When deep_crawl_strategy is None, arun() returns a single
                # CrawlResult; otherwise it returns an async iterator (stream=True).
                if hasattr(arun_ret, "__aiter__"):
                    result_iter = arun_ret
                else:
                    async def _single():
                        yield arun_ret
                    result_iter = _single()
                async for result in result_iter:
                    url = getattr(result, "url", args.url)
                    # Apply include/exclude filter BEFORE emitting an error so
                    # cross-product links on shared docs hosts (e.g.
                    # developer.hashicorp.com) don't pollute the error log.
                    if not url_matches(url, include_patterns):
                        continue
                    if exclude_patterns and url_matches(url, exclude_patterns):
                        continue
                    if not getattr(result, "success", False):
                        emit({
                            "type": "worker-error",
                            "alias": args.alias,
                            "url": url,
                            "error": getattr(result, "error_message", "unknown") or "unknown",
                            "fatal": False,
                        })
                        continue


                    markdown = extract_markdown(result)
                    if not markdown.strip():
                        continue

                    ph = stable_hash(markdown)
                    known = None if bypass else known_pages.get(url)
                    if known and known.get("pageHash") == ph:
                        emit({
                            "type": "page-unchanged",
                            "alias": args.alias,
                            "url": url,
                            "pageHash": ph,
                        })
                        pages_skipped += 1
                        emit_progress(args.alias, pages_scraped + pages_skipped, pages_total, url)
                        continue

                    emit({
                        "type": "page-fetched",
                        "alias": args.alias,
                        "url": url,
                        "title": extract_title(result),
                        "markdown": markdown,
                        "links": extract_internal_links(result),
                        "hash": ph,
                    })
                    pages_scraped += 1
                    emit_progress(args.alias, pages_scraped + pages_skipped, pages_total, url)

                    if pages_scraped + pages_skipped >= args.max_pages:
                        break
    except Exception as exc:  # noqa: BLE001
        emit({
            "type": "worker-error",
            "alias": args.alias,
            "error": f"{type(exc).__name__}: {exc}",
            "fatal": True,
        })
        return 1

    elapsed_ms = int((time.time() - started) * 1000)
    emit({
        "type": "source-done",
        "alias": args.alias,
        "summary": {
            "pagesScraped": pages_scraped,
            "pagesSkipped": pages_skipped,
            "chunksWritten": 0,
            "elapsedMs": elapsed_ms,
        },
    })
    return 0


def emit_progress(alias: str, done: int, total: int, current_url: str) -> None:
    emit({
        "type": "worker-progress",
        "alias": alias,
        "pagesDone": done,
        "pagesTotal": max(total, done),
        "currentUrl": current_url,
    })


def main() -> int:
    parser = argparse.ArgumentParser(description="Crawl4AI worker for kra ai docs")
    parser.add_argument("--alias", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--max-depth", type=int, default=0)
    parser.add_argument("--max-pages", type=int, default=50)
    parser.add_argument("--include", action="append", default=[])
    parser.add_argument("--exclude", action="append", default=[])
    parser.add_argument("--mode", choices=["auto", "http", "browser"], default="auto")
    parser.add_argument("--concurrency", type=int, default=0)
    parser.add_argument("--page-timeout-ms", type=int, default=20000)
    args = parser.parse_args()

    parsed = urlparse(args.url)
    if parsed.scheme not in ("http", "https"):
        emit({
            "type": "worker-error",
            "alias": args.alias,
            "error": f"unsupported url scheme: {parsed.scheme!r}",
            "fatal": True,
        })
        return 2

    payload = read_stdin_payload()

    try:
        return asyncio.run(crawl(args, payload))
    except KeyboardInterrupt:
        emit({
            "type": "worker-error",
            "alias": args.alias,
            "error": "interrupted",
            "fatal": True,
        })
        return 130


if __name__ == "__main__":
    sys.exit(main())
