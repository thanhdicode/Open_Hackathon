/**
 * HTML parsing tests.
 *
 * These exist because of a measured failure, not a hypothetical one. On
 * 2026-09-16 the ICA Student's Pass pages — the most important Singapore
 * sources in the registry, both authority A — parsed to **0 characters of
 * text** and the pipeline skipped them as "too little text". The 29,845-byte
 * document was fine; the parser threw it away.
 *
 * Two compounding causes, both covered here:
 *   1. A `\b`-less `content|main|article` match treated `site-header__main` as a
 *      main-content region, so the parser grabbed the site header.
 *   2. The non-greedy `</div>` stopped at the first *nested* close, capturing
 *      485 of 29,845 bytes.
 *
 * Run: node --test scripts/greenbook/fetch.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contentContainer, htmlToText, stripBoilerplate } from "./fetch.mjs";

test("a content div with nested divs is not truncated at the first close", () => {
  // The exact shape that broke: minified, nested, no <main> and no <article>.
  const html =
    '<html><body><div class="site-header__main"><div class="container">MENU</div></div>' +
    '<div id="content"><div class="wrapper"><p>' +
    "A foreigner accepted by an educational institution to pursue full-time studies will need to apply for a Student's Pass." +
    "</p></div></div></body></html>";

  const text = htmlToText(html);
  assert.ok(text.includes("full-time studies"), "the real content must survive");
  assert.ok(text.length > 100, `expected real content, got ${text.length} chars`);
});

test("a header whose class contains 'main' is not treated as main content", () => {
  const html =
    '<div class="site-header__main">NAVIGATION CHROME</div>' +
    '<div class="page-content"><p>REAL REQUIREMENT TEXT that a student needs to read.</p></div>';

  const container = contentContainer(html);
  assert.ok(!container.includes("NAVIGATION CHROME"), "the header must not be selected as content");
  assert.ok(container.includes("REAL REQUIREMENT"));
});

test("<main> is preferred over a content div", () => {
  const html = '<div class="content">DIV CONTENT</div><main>MAIN CONTENT</main>';
  assert.ok(contentContainer(html).includes("MAIN CONTENT"));
});

test("<article> is used when there is no <main>", () => {
  const html = '<div class="content">DIV CONTENT</div><article>ARTICLE CONTENT</article>';
  assert.ok(contentContainer(html).includes("ARTICLE CONTENT"));
});

test("the largest candidate wins, not the first one found", () => {
  // A page can carry several plausibly-named containers; the real content is big.
  const html =
    '<div class="content">tiny</div>' +
    '<div id="main-content"><p>' + "x".repeat(900) + "</p></div>";
  assert.ok(contentContainer(html).includes("x".repeat(900)), "the larger region must win");
});

test("chrome containers named like content are excluded", () => {
  for (const name of ["cookie-content-banner", "footer-content", "nav-content", "sidebar-content"]) {
    const html = `<div class="${name}">CHROME</div><div class="main-content">BODY</div>`;
    const container = contentContainer(html);
    assert.ok(container.includes("BODY"), `${name} must not win`);
    assert.ok(!container.includes("CHROME"), `${name} must not be selected`);
  }
});

test("a document with no recognisable container falls back to the whole body", () => {
  const html = "<html><body><p>PLAIN CONTENT with no wrapper at all.</p></body></html>";
  assert.ok(contentContainer(html).includes("PLAIN CONTENT"));
});

test("a bad container pick falls back to the whole document", () => {
  /*
   * Measured on `my-emgs`: the container pick returned 12 characters from a
   * 170,706-byte page while the whole document held 9,525. The pick had grabbed
   * a table-of-contents block. Across all 15 archived snapshots the picked/whole
   * text ratio separated good picks (81-100%) from bad ones (0-43%), so the rule
   * is: keep less than half the document's text and the pick is not trusted.
   */
  const html =
    '<html><body><div class="content-toc">TABLE OF CONTENTS</div>' +
    "<div class=\"wrapper\"><p>" + "A real requirement a student must follow. ".repeat(30) + "</p></div>" +
    "</body></html>";

  const text = htmlToText(html);
  assert.ok(text.includes("A real requirement a student must follow"), "the real content must be recovered");
  assert.ok(text.length > 500, `expected the whole document, got ${text.length} chars`);
});

test("a good container pick is still preferred over the whole document", () => {
  // The fallback must not throw away noise reduction when the pick is sound.
  const chrome = "<nav>HOME ABOUT CONTACT SITEMAP</nav>".repeat(20);
  const html = '<html><body>' + chrome + '<div id="main-content"><p>THE ACTUAL REQUIREMENT.</p></div></body></html>';
  const text = htmlToText(html);
  assert.ok(text.includes("THE ACTUAL REQUIREMENT"));
  assert.ok(!text.includes("SITEMAP"), "chrome outside the container stays out");
});

test("a chrome region holding most of the document is kept", () => {
  /*
   * Measured on `id-bank-indonesia`: a single <form> region spanned 148,508 of
   * 163,260 bytes (91%). Stripping it left 14 characters from a 163 KB page, and
   * the source looked dead. Broken markup must not be able to empty a document.
   *
   * The body is deliberately large: the guard needs BOTH a large absolute size
   * and a large share, so a small fixture would not exercise it at all.
   */
  const body = "<p>" + "A real requirement students must follow. ".repeat(600) + "</p>";
  const html = "<html><body><form>" + body + "</form></body></html>";
  assert.ok(html.length > 20_000, "fixture must exceed the absolute guard");

  const text = htmlToText(html);
  assert.ok(text.includes("A real requirement"), "content inside an oversized form must survive");
  assert.ok(text.length > 20_000, `expected the content to be kept, got ${text.length} chars`);
});

test("a normally-sized chrome region is still stripped", () => {
  const html =
    '<html><body><form><input type="text" placeholder="Search"><button>SEARCH BUTTON LABEL</button></form>' +
    "<main><p>REAL CONTENT.</p></main></body></html>";

  const text = htmlToText(html);
  assert.ok(text.includes("REAL CONTENT"));
  assert.ok(!text.includes("SEARCH BUTTON LABEL"), "a normal-sized form is chrome and must go");
});

test("dropdown option text is removed as chrome", () => {
  const html =
    '<div id="main-content"><select><option>Choose a country</option><option>Singapore</option></select>' +
    "<p>KEEP THIS REQUIREMENT.</p></div>";
  const text = htmlToText(html);
  assert.ok(text.includes("KEEP THIS REQUIREMENT"));
  assert.ok(!text.includes("Choose a country"), "select options are not content");
});

test("an oversized script is still removed however large it is", () => {
  // The size guard must apply to chrome, never to script/style: a 300 KB inline
  // bundle is not prose no matter how big it is.
  const html = "<html><body><script>" + "var x = 1;".repeat(2000) + "</script><p>REAL CONTENT.</p></body></html>";
  const text = htmlToText(html);
  assert.ok(text.includes("REAL CONTENT"));
  assert.ok(!text.includes("var x"), "scripts are removed at any size");
});

test("nested same-tag regions resolve to the correct close", () => {
  // Balanced counting, not regex: the inner div must not end the outer one.
  const html = '<div class="content"><div class="inner">A</div><div class="inner">B</div></div>';
  const container = contentContainer(html);
  assert.ok(container.includes("A") && container.includes("B"), "both inner regions must be inside");
});

test("script, style, nav and footer are stripped", () => {
  const html =
    '<div class="content"><nav>MENU</nav><script>var x = 1;</script><style>.a{}</style>' +
    "<p>KEEP THIS SENTENCE.</p><footer>COPYRIGHT</footer></div>";
  const text = htmlToText(html);
  assert.ok(text.includes("KEEP THIS SENTENCE"));
  for (const noise of ["MENU", "var x", ".a{}", "COPYRIGHT"]) {
    assert.ok(!text.includes(noise), `"${noise}" should have been stripped`);
  }
});

test("numeric and named entities are decoded", () => {
  const text = htmlToText("<p>Student Pass &#8211; RM60 &amp; RM90 &#x27;fee&#x27;</p>");
  assert.ok(text.includes("\u2013"), "decimal entity decoded");
  assert.ok(text.includes("&"), "named entity decoded");
  assert.ok(text.includes("'fee'"), "hex entity decoded");
});

test("boilerplate stripping removes menu-shaped and chrome lines", () => {
  const text = ["Home | About Us | Contact Us | Sitemap", "Home", "Apply for a Student's Pass before arriving.", "Home"].join("\n");
  const cleaned = stripBoilerplate(text);
  assert.ok(cleaned.includes("Apply for a Student's Pass"));
  assert.ok(!cleaned.includes("Sitemap"), "a pipe-dense menu line is dropped");
});

/*
 * Tailwind arbitrary variants: a `>` INSIDE a class attribute.
 *
 * Measured 2026-09-16 on chula.ac.th/en/international-students. The naive
 * `/<[^>]+>/g` tag regex ended the tag at the `>` inside `[&>li>a]`, so the rest
 * of the class attribute was emitted as if it were prose:
 *
 *   li>a]:py-1! [&>li>a]:px-0! pb-3 whitespace-nowrap">
 *
 * Every such element added another fragment, so the corruption scaled with the
 * page — and those fragments were sent to the model as candidate fact text. This
 * is not a Thailand-only problem: Tailwind is used by most modern sites.
 */
test("a `>` inside a class attribute does not leak the attribute into the text", () => {
  const html = `<div class="[&>li>a]:py-1! [&>li>a]:px-0! pb-3 whitespace-nowrap"><p>KEEP THIS</p></div>`;
  const text = htmlToText(html);
  assert.ok(text.includes("KEEP THIS"), "real content survives");
  assert.ok(!text.includes("li>a]"), "no leaked class fragment");
  assert.ok(!text.includes("px-0!"), "no leaked utility class");
  assert.ok(!text.includes("whitespace-nowrap"), "no leaked utility class");
});

test("quoted `>` in a single-quoted attribute is also respected", () => {
  const html = `<a class='[&>span]:text-red' href="/x">LINK TEXT</a>`;
  const text = htmlToText(html);
  assert.ok(text.includes("LINK TEXT"));
  assert.ok(!text.includes("span]:text-red"));
});

test("an unterminated `<` is kept as text rather than deleting the document", () => {
  // A malformed document must lose at most the malformed tag, never the rest.
  const text = htmlToText("<p>BEFORE</p><div class=\"unclosed");
  assert.ok(text.includes("BEFORE"), "content before the malformed tag survives");
});

test("an attribute value containing a literal `>` still ends the tag correctly", () => {
  const html = `<meta content="a > b"><p>VISIBLE</p>`;
  const text = htmlToText(html);
  assert.ok(text.includes("VISIBLE"));
});
