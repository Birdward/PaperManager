"""
Blog RSS/Atom fetching and content extraction.

Registered blogs and their parsers:
  substack        — magazine.sebastianraschka.com, pascalnotin.substack.com
  wordpress       — forwardevery.day
  jekyll          — you.github.io
  google_research — ai.google/research/ (feed: research.google/blog/rss/)
"""

import re
import httpx
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from urllib.parse import urlparse

from bs4 import BeautifulSoup


HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; PaperManager/1.0)"}

# ── Known blog registry ────────────────────────────────────────────────────────

BLOG_REGISTRY: dict[str, dict] = {
    "magazine.sebastianraschka.com": {
        "name": "Ahead of AI",
        "feed_url": "https://magazine.sebastianraschka.com/feed",
        "parser": "substack",
        "description": "ML and AI research newsletter by Sebastian Raschka, PhD",
    },
    "pascalnotin.substack.com": {
        "name": "Pascal Notin",
        "feed_url": "https://pascalnotin.substack.com/feed",
        "parser": "substack",
        "description": "AI for protein design by Pascal Notin",
    },
    "forwardevery.day": {
        "name": "Yantra Blog",
        "feed_url": "https://forwardevery.day/feed",
        "parser": "wordpress",
        "description": "Engineering blog on AI/ML, GPU architecture, 5G and embedded systems",
    },
    "you.github.io": {
        "name": "Karin you",
        "feed_url": "https://you.github.io/feed",
        "parser": "jekyll",
        "description": "Data science blog on topics that don't get published",
    },
    "ai.google": {
        "name": "Google Research Blog",
        "feed_url": "https://research.google/blog/rss/",
        "parser": "google_research",
        "description": "Latest research from Google — AI, ML, health, quantum and more",
    },
}


def detect_blog_config(url: str) -> dict | None:
    """Return the known config for a URL if it matches a registered blog."""
    domain = urlparse(url).netloc.lstrip("www.")
    return BLOG_REGISTRY.get(domain)


def auto_detect_feed(url: str) -> str | None:
    """
    Try to auto-detect the RSS/Atom feed URL for an unknown blog.
    Looks for <link rel=alternate> in the homepage, then tries common paths.
    """
    common_paths = ["/feed", "/rss", "/feed.xml", "/atom.xml", "/rss.xml", "/feed/"]
    with httpx.Client(headers=HEADERS, verify=False, timeout=15) as client:
        # Try homepage for embedded feed link
        try:
            r = client.get(url, follow_redirects=True, timeout=10)
            matches = re.findall(
                r'<link[^>]*type=["\']application/(?:rss|atom)\+xml["\'][^>]*href=["\']([^"\']+)["\']',
                r.text,
                re.IGNORECASE,
            )
            if matches:
                href = matches[0]
                if href.startswith("/"):
                    base = f"{urlparse(url).scheme}://{urlparse(url).netloc}"
                    return base + href
                return href
        except Exception:
            pass

        # Try common feed paths
        base = url.rstrip("/")
        for path in common_paths:
            try:
                r = client.get(base + path, follow_redirects=True, timeout=8)
                ct = r.headers.get("content-type", "")
                if r.status_code == 200 and (
                    "xml" in ct or "rss" in ct or "atom" in ct
                    or r.text.strip().startswith("<?xml")
                    or "<rss" in r.text[:200]
                    or "<feed" in r.text[:200]
                ):
                    return base + path
            except Exception:
                pass
    return None


# ── Feed parsing ───────────────────────────────────────────────────────────────

def fetch_feed_posts(feed_url: str, parser: str) -> list[dict]:
    """
    Fetch and parse RSS/Atom feed. Returns post stubs.
    For substack/wordpress: full text extracted from content:encoded in feed.
    For jekyll: only summary available; content must be fetched separately.
    """
    with httpx.Client(headers=HEADERS, verify=False, timeout=20) as client:
        r = client.get(feed_url, follow_redirects=True, timeout=20)
        r.raise_for_status()
        xml_text = r.text

    root = ET.fromstring(xml_text)
    tag = root.tag.lower()

    if "feed" in tag:  # Atom
        return _parse_atom(root, parser)
    else:  # RSS
        return _parse_rss(root, parser)


def _parse_rss(root: ET.Element, parser: str) -> list[dict]:
    import json as _json
    CONTENT_NS = "http://purl.org/rss/1.0/modules/content/"
    DC_NS = "http://purl.org/dc/elements/1.1/"

    channel = root.find("channel")
    if channel is None:
        return []

    posts = []
    for item in channel.findall("item"):
        title = _el_text(item, "title") or ""
        url = _el_text(item, "link") or ""
        pub_date = _el_text(item, "pubDate") or ""
        description = _el_text(item, "description") or ""
        author = (
            _el_text(item, f"{{{DC_NS}}}creator")
            or _el_text(item, "author")
            or ""
        )

        content_el = item.find(f"{{{CONTENT_NS}}}encoded")
        content_html = (content_el.text or "") if content_el is not None else description

        if parser in ("substack", "wordpress") and content_html:
            html_soup = BeautifulSoup(content_html, "lxml")
            content_text = _html_to_text(content_html)
            content_md = _html_to_markdown(html_soup)
            figures = _extract_figures(html_soup, url.strip())
            references_json = _json.dumps(
                _extract_reference_links(html_soup), ensure_ascii=False
            )
            imported = True
        else:
            content_text = _strip_html(description)
            content_md = ""
            figures = []
            references_json = "[]"
            imported = False

        posts.append({
            "title": _strip_cdata(title),
            "url": url.strip(),
            "author": _strip_cdata(author),
            "published_at": _parse_date(pub_date),
            "description": _strip_html(_strip_cdata(description))[:500],
            "content": content_text,
            "content_md": content_md,
            "figures": figures,
            "references_json": references_json,
            "imported": imported,
        })

    return posts


def _parse_atom(root: ET.Element, parser: str) -> list[dict]:
    """Parse Atom feed (used by Jekyll/you.github.io)."""
    NS = "http://www.w3.org/2005/Atom"
    posts = []

    for entry in root.findall(f"{{{NS}}}entry"):
        title_el = entry.find(f"{{{NS}}}title")
        title = (title_el.text or "") if title_el is not None else ""

        link_el = entry.find(f"{{{NS}}}link[@rel='alternate']") or entry.find(f"{{{NS}}}link")
        url = (link_el.get("href", "") if link_el is not None else "").strip()

        author_el = entry.find(f"{{{NS}}}author/{{{NS}}}name")
        author = (author_el.text or "") if author_el is not None else ""

        published_el = entry.find(f"{{{NS}}}published") or entry.find(f"{{{NS}}}updated")
        published_at = (published_el.text or "") if published_el is not None else ""

        summary_el = entry.find(f"{{{NS}}}summary")
        description = (summary_el.text or "") if summary_el is not None else ""

        # Atom <content> with src= means external content (no inline text)
        content_el = entry.find(f"{{{NS}}}content")
        content_text = ""
        imported = False
        if content_el is not None and content_el.text:
            content_text = _html_to_text(content_el.text)
            imported = True

        posts.append({
            "title": title.strip(),
            "url": url,
            "author": author.strip(),
            "published_at": _parse_date(published_at),
            "description": description.strip()[:500],
            "content": content_text,
            "imported": imported,
        })

    return posts


# ── Full-content fetching (for Jekyll / on-demand) ─────────────────────────────

def fetch_post_full_content(url: str, parser: str) -> str:
    """Fetch a post page and return clean plain text (legacy / simple path)."""
    return fetch_post_extras(url, parser)["content"]


def fetch_post_extras(url: str, parser: str) -> dict:
    """
    Fetch a post page and return:
      content       — clean plain text
      content_md    — Ollama-formatted markdown (empty string if Ollama unavailable)
      figures       — list of image URL strings extracted from the page
      references    — JSON string: list of {title, url} dicts for external links
      imported      — always True
    """
    import json as _json

    with httpx.Client(headers=HEADERS, verify=False, timeout=20, follow_redirects=True) as client:
        r = client.get(url)
        r.raise_for_status()

    soup = BeautifulSoup(r.text, "lxml")

    # ── Content text ────────────────────────────────────────────────────────────
    if parser == "jekyll":
        content_el = (
            soup.select_one("#post-content")
            or soup.select_one("div.post-content")
            or soup.select_one("article .content")
            or soup.select_one(".e-content")
            or soup.select_one("article")
            or soup.select_one("main")
        )
    elif parser == "substack":
        content_el = (
            soup.select_one("div.body.markup")
            or soup.select_one("div.available-content")
            or soup.select_one("article")
            or soup.select_one("main")
        )
    elif parser == "wordpress":
        content_el = (
            soup.select_one("div.entry-content")
            or soup.select_one("div.post-content")
            or soup.select_one("article.post")
            or soup.select_one("article")
            or soup.select_one("main")
        )
    elif parser == "google_research":
        content_el = soup.select_one("main")
    else:
        content_el = soup.select_one("main") or soup.select_one("article") or soup.body

    if content_el is None:
        content_el = soup.body or soup

    for noise in content_el.select("script, style, nav, button, [class*='video'], [class*='nav']"):
        noise.decompose()

    content = content_el.get_text(separator="\n", strip=True)
    # Strip video-control noise for Google Research
    content = re.sub(
        r"^(play silent looping video\n|pause silent looping video\n|unmute video\n|mute video\n)+",
        "", content, flags=re.IGNORECASE,
    ).strip()

    # ── Figures & references — from the content element ─────────────────────────
    figures = _extract_figures(content_el, url)
    references_json = _json.dumps(_extract_reference_links(content_el), ensure_ascii=False)

    # ── Markdown conversion → Ollama cleanup ────────────────────────────────────
    content_md_raw = _html_to_markdown(content_el)
    content_md = _format_markdown_ollama(content_md_raw)

    return {
        "content": content,
        "content_md": content_md,
        "figures": figures,          # list of str (URLs)
        "references_json": references_json,
        "imported": True,
    }


def _extract_figures(soup: BeautifulSoup, base_url: str) -> list[str]:
    """Extract meaningful image URLs from the page (skip icons & data URIs)."""
    from urllib.parse import urljoin, urlparse as _up
    seen: set[str] = set()
    result: list[str] = []

    for img in soup.find_all("img", src=True):
        src = img.get("src", "").strip()
        if not src or src.startswith("data:"):
            continue

        # Skip tracking pixels / tiny images
        w = img.get("width") or img.get("data-width") or ""
        h = img.get("height") or img.get("data-height") or ""
        try:
            if w and int(str(w).replace("px", "")) < 60:
                continue
            if h and int(str(h).replace("px", "")) < 60:
                continue
        except (ValueError, AttributeError):
            pass

        # Make absolute
        if src.startswith("//"):
            src = "https:" + src
        elif src.startswith("/"):
            parsed = _up(base_url)
            src = f"{parsed.scheme}://{parsed.netloc}{src}"
        elif not src.startswith("http"):
            src = urljoin(base_url, src)

        # Deduplicate & cap
        if src not in seen:
            seen.add(src)
            result.append(src)
            if len(result) >= 30:
                break

    return result


def _extract_reference_links(soup: BeautifulSoup) -> list[dict]:
    """Extract meaningful external links from the post body."""
    # Work on a copy so we don't disturb the content extraction
    for tag in soup.select("nav, footer, header, [class*='nav'], [class*='footer']"):
        tag.decompose()

    seen: set[str] = set()
    result: list[dict] = []

    for a in soup.find_all("a", href=True):
        href = a.get("href", "").strip()
        text = a.get_text(strip=True)

        if not href.startswith("http"):
            continue
        if not text or len(text) < 3:
            continue
        # Skip social share, tracking, and generic "click here" links
        boring = {"click here", "here", "link", "source", "read more", "learn more"}
        if text.lower() in boring:
            continue
        if href in seen:
            continue

        seen.add(href)
        result.append({"title": text[:120], "url": href})
        if len(result) >= 50:
            break

    return result


def _format_markdown_ollama(markdown: str) -> str:
    """
    Light Ollama cleanup pass on already-structured markdown:
    - Converts ASCII/text math expressions to LaTeX ($...$ inline, $$...$$ block)
    - Fixes broken headings or paragraph merges from the HTML extractor
    - Returns the input unchanged if LiteLLM is unavailable
    """
    if not markdown or not markdown.strip():
        return ""
    try:
        from services.litellm_client import chat_completion, litellm_configured

        prompt = (
            "You are a markdown editor. The text below is already in markdown format.\n"
            "Your ONLY jobs are:\n"
            "1. Convert any math formulas, equations, or expressions to proper LaTeX:\n"
            "   - Inline math → $formula$\n"
            "   - Block/display math → $$formula$$\n"
            "2. Fix any obviously merged paragraphs (add a blank line between them).\n"
            "3. Do NOT rewrite, summarise, add, or remove any content.\n"
            "4. Output ONLY the corrected markdown — no preamble, no explanation.\n\n"
            f"Markdown:\n{markdown[:7000 if litellm_configured() else 60_000]}"
        )
        out = chat_completion(messages=[{"role": "user", "content": prompt}])
        # Sanity-check: model output must be at least half the length of input
        return out if len(out) > len(markdown) * 0.4 else markdown
    except Exception:
        return markdown  # fall back to the already-structured input


def _extract_jekyll(soup: BeautifulSoup) -> str:
    """
    Chirpy theme (you.github.io) content extraction.
    Tries selectors in priority order.
    """
    for selector in [
        "#post-content",
        "div.post-content",
        "article .content",
        ".e-content",
        "article",
        "main",
    ]:
        el = soup.select_one(selector)
        if el:
            for tag in el.select("nav, .post-nav, .post-tags, .post-share, script, style"):
                tag.decompose()
            return el.get_text(separator="\n", strip=True)
    return _extract_generic(soup)


def _extract_substack_page(soup: BeautifulSoup) -> str:
    """Substack post page parser (fallback — normally content comes from RSS)."""
    el = (
        soup.select_one("div.body.markup")
        or soup.select_one("div.available-content")
        or soup.select_one("article")
        or soup.select_one("main")
    )
    if el:
        for tag in el(["script", "style"]):
            tag.decompose()
        return el.get_text(separator="\n", strip=True)
    return _extract_generic(soup)


def _extract_wordpress_page(soup: BeautifulSoup) -> str:
    """WordPress post page parser (fallback — normally content comes from RSS)."""
    el = (
        soup.select_one("div.entry-content")
        or soup.select_one("div.post-content")
        or soup.select_one("article.post")
        or soup.select_one("article")
        or soup.select_one("main")
    )
    if el:
        for tag in el(["script", "style", "nav", "footer"]):
            tag.decompose()
        return el.get_text(separator="\n", strip=True)
    return _extract_generic(soup)


def _extract_google_research(soup: BeautifulSoup) -> str:
    """
    research.google blog post parser.
    Posts use a <main> element; video-control noise is stripped.
    Author line appears just below the date, before the article body.
    """
    main = soup.select_one("main")
    if not main:
        return _extract_generic(soup)

    # Remove video control buttons and nav elements
    for tag in main.select("button, nav, [class*='video'], [class*='nav'], script, style"):
        tag.decompose()

    text = main.get_text(separator="\n", strip=True)

    # Strip the "play/pause/mute/unmute" noise lines that appear before the title
    text = re.sub(
        r"^(play silent looping video\n|pause silent looping video\n|unmute video\n|mute video\n)+",
        "",
        text,
        flags=re.IGNORECASE,
    )
    return text.strip()


def _extract_generic(soup: BeautifulSoup) -> str:
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()
    main = soup.select_one("main") or soup.select_one("article") or soup.body
    if main:
        return main.get_text(separator="\n", strip=True)
    return soup.get_text(separator="\n", strip=True)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _html_to_text(html: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()
    return soup.get_text(separator="\n", strip=True)


def _html_to_markdown(soup: BeautifulSoup) -> str:
    """
    Convert a BeautifulSoup tree to structured markdown, preserving headings,
    lists, bold/italic, links, code blocks, and images.
    """
    from bs4 import NavigableString, Tag

    def _node(n, list_type: str | None = None, list_index: int = 0) -> str:
        if isinstance(n, NavigableString):
            return str(n)
        if not isinstance(n, Tag):
            return ""

        tag = n.name.lower() if n.name else ""

        # Invisible / structural noise
        if tag in ("script", "style", "nav", "footer", "header", "button",
                   "form", "input", "select", "textarea", "svg", "noscript"):
            return ""

        children = lambda: "".join(_node(c) for c in n.children)

        if tag == "h1":
            return f"\n\n# {children().strip()}\n\n"
        if tag == "h2":
            return f"\n\n## {children().strip()}\n\n"
        if tag == "h3":
            return f"\n\n### {children().strip()}\n\n"
        if tag in ("h4", "h5", "h6"):
            return f"\n\n#### {children().strip()}\n\n"
        if tag == "p":
            inner = children().strip()
            return f"\n\n{inner}\n\n" if inner else ""
        if tag in ("strong", "b"):
            inner = children().strip()
            return f"**{inner}**" if inner else ""
        if tag in ("em", "i"):
            inner = children().strip()
            return f"*{inner}*" if inner else ""
        if tag == "code":
            # Inline code — single backtick
            return f"`{children()}`"
        if tag == "pre":
            # Block code — fenced
            code_el = n.find("code")
            lang = ""
            if code_el:
                cls = " ".join(code_el.get("class", []))
                m = re.search(r"language-(\w+)", cls)
                lang = m.group(1) if m else ""
                body = code_el.get_text()
            else:
                body = n.get_text()
            return f"\n\n```{lang}\n{body.strip()}\n```\n\n"
        if tag == "blockquote":
            inner = children().strip()
            quoted = "\n".join(f"> {l}" for l in inner.split("\n"))
            return f"\n\n{quoted}\n\n"
        if tag == "a":
            href = n.get("href", "").strip()
            inner = children().strip()
            if not inner:
                return ""
            if href and href != inner and not href.startswith("#"):
                return f"[{inner}]({href})"
            return inner
        if tag == "img":
            src = n.get("src", "").strip()
            alt = n.get("alt", "").strip()
            if src and not src.startswith("data:"):
                if src.startswith("//"):
                    src = "https:" + src
                return f"\n\n![{alt}]({src})\n\n"
            return ""
        if tag == "ul":
            items = [c for c in n.children if isinstance(c, Tag) and c.name == "li"]
            lines = []
            for li in items:
                item_md = "".join(_node(c) for c in li.children).strip()
                lines.append(f"- {item_md}")
            return "\n\n" + "\n".join(lines) + "\n\n" if lines else ""
        if tag == "ol":
            items = [c for c in n.children if isinstance(c, Tag) and c.name == "li"]
            lines = []
            for i, li in enumerate(items, 1):
                item_md = "".join(_node(c) for c in li.children).strip()
                lines.append(f"{i}. {item_md}")
            return "\n\n" + "\n".join(lines) + "\n\n" if lines else ""
        if tag == "hr":
            return "\n\n---\n\n"
        if tag == "br":
            return "\n"
        if tag == "table":
            return "\n\n" + _table_to_md(n) + "\n\n"

        # Pass-through containers
        return children()

    def _table_to_md(table: Tag) -> str:
        rows = table.find_all("tr")
        if not rows:
            return ""
        md_rows = []
        for i, row in enumerate(rows):
            cells = row.find_all(["th", "td"])
            row_md = "| " + " | ".join(c.get_text(strip=True) for c in cells) + " |"
            md_rows.append(row_md)
            if i == 0:
                sep = "| " + " | ".join("---" for _ in cells) + " |"
                md_rows.append(sep)
        return "\n".join(md_rows)

    # Strip noise from a copy
    working = BeautifulSoup(str(soup), "lxml")
    for el in working(["script", "style", "nav", "footer", "header", "button"]):
        el.decompose()

    raw = _node(working)
    # Collapse 3+ consecutive blank lines → 2
    raw = re.sub(r"\n{3,}", "\n\n", raw)
    return raw.strip()


def _strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", " ", s).strip()


def _strip_cdata(s: str) -> str:
    if not s:
        return ""
    return re.sub(r"<!\[CDATA\[(.*?)\]\]>", r"\1", s, flags=re.DOTALL).strip()


def _el_text(el: ET.Element, tag: str) -> str | None:
    child = el.find(tag)
    if child is None:
        return None
    return (child.text or "").strip() or None


def _parse_date(date_str: str) -> str:
    if not date_str:
        return datetime.now(timezone.utc).isoformat()
    formats = [
        "%a, %d %b %Y %H:%M:%S %z",
        "%a, %d %b %Y %H:%M:%S GMT",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S+%f",
    ]
    for fmt in formats:
        try:
            return datetime.strptime(date_str.strip(), fmt).isoformat()
        except ValueError:
            continue
    # Try email.utils for RFC 2822
    try:
        from email.utils import parsedate_to_datetime
        return parsedate_to_datetime(date_str).isoformat()
    except Exception:
        pass
    return datetime.now(timezone.utc).isoformat()
