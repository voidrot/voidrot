#!/usr/bin/env node
// Refreshes the generated parts of the profile README:
//   1. the latest blog posts between the BLOG markers (from the site RSS feed)
//   2. assets/activity-{dark,light}.svg (from public GitHub repos via GraphQL)
// Zero dependencies, Node 22+. Everything is fetched before anything is written,
// so a failed fetch never leaves the repo half-updated.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const LOGIN = "voidrot";
const RSS_URL = "https://buckbrady.com/rss.xml";
const POST_COUNT = 3;
const MAX_LANGS = 6;
const MAX_RECENT = 3;
const PROSE = new Set(["Markdown"]); // docs, not a language I write in

const root = new URL("../", import.meta.url);
const path = (p) => fileURLToPath(new URL(p, root));

// ---------- blog ----------

const ENTITIES = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

// One pass, so "&amp;lt;" decodes to "&lt;" and not "<". CDATA text is taken literally.
const decodeEntities = (s) =>
  s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|quot|apos|amp));/gi, (m, hex, dec, name) => {
    if (name) return ENTITIES[name.toLowerCase()];
    const cp = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });

const decodeXml = (s) => {
  const cdata = s.trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return cdata ? cdata[1] : decodeEntities(s);
};

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]).trim() : "";
};

async function fetchPosts() {
  const res = await fetch(RSS_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();
  const posts = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map(([, item]) => ({
      title: tag(item, "title"),
      link: safeLink(tag(item, "link")),
      date: new Date(tag(item, "pubDate")),
    }))
    .filter((p) => p.title && p.link && !Number.isNaN(p.date.getTime()))
    .sort((a, b) => b.date - a.date || a.link.localeCompare(b.link))
    .slice(0, POST_COUNT);
  if (posts.length === 0) throw new Error("RSS feed had no usable posts");
  return posts;
}

const fmtDate = (d) =>
  d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

const SITE_PREFIX = "https://buckbrady.com/";

// Titles come from a remote feed: flatten whitespace, neutralise HTML (including "<!--")
// and markdown punctuation so a title can't alter the README around it.
const escapeTitle = (s) =>
  s
    .replace(/\s+/g, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[`*_[\]\\]/g, "\\$&");

// Only first-party links; empty string fails the post filter.
const safeLink = (u) =>
  u.startsWith(SITE_PREFIX) ? u.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20") : "";

function renderBlog(posts) {
  return posts
    .map((p) => `- [${escapeTitle(p.title)}](${p.link}) <sub>${fmtDate(p.date)}</sub>`)
    .join("\n");
}

function replaceBlock(readme, body) {
  const re = /(<!-- BLOG:START -->)[\s\S]*?(<!-- BLOG:END -->)/;
  if (!re.test(readme)) throw new Error("BLOG markers not found in README.md");
  return readme.replace(re, (_, a, b) => `${a}\n${body}\n${b}`);
}

// ---------- activity ----------

const QUERY = `
query($login: String!, $after: String) {
  user(login: $login) {
    repositories(
      first: 100, after: $after, privacy: PUBLIC, isFork: false,
      ownerAffiliations: OWNER, orderBy: { field: NAME, direction: ASC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        isArchived
        isPrivate
        isFork
        pushedAt
        languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name } }
        }
      }
    }
  }
}`;

async function fetchRepos(token) {
  const repos = [];
  let after = null;
  for (;;) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "voidrot-profile-readme",
      },
      body: JSON.stringify({ query: QUERY, variables: { login: LOGIN, after } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`GraphQL fetch failed: ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
    const page = json.data.user.repositories;
    repos.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  // Defense in depth: the query already filters, but never count anything else.
  // The profile repo itself is excluded: the bot's own daily commits would otherwise
  // change the next run's output.
  return repos.filter((r) => !r.isPrivate && !r.isFork && !r.isArchived && r.name !== LOGIN);
}

function summarize(repos) {
  const bytes = new Map();
  for (const r of repos) {
    for (const e of r.languages.edges) if (!PROSE.has(e.node.name)) bytes.set(e.node.name, (bytes.get(e.node.name) ?? 0) + e.size);
  }
  const total = [...bytes.values()].reduce((a, b) => a + b, 0);
  const sorted = [...bytes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const langs = sorted.slice(0, MAX_LANGS).map(([name, size]) => ({ name, size }));
  const rest = sorted.slice(MAX_LANGS).reduce((a, [, s]) => a + s, 0);
  if (rest > 0) langs.push({ name: "Other", size: rest });
  for (const l of langs) l.pct = total ? (l.size / total) * 100 : 0;

  const recent = [...repos]
    .filter((r) => r.pushedAt)
    .sort((a, b) => b.pushedAt.localeCompare(a.pushedAt) || a.name.localeCompare(b.name))
    .slice(0, MAX_RECENT)
    .map((r) => ({ name: r.name, date: r.pushedAt.slice(0, 10) }));

  return { count: repos.length, langs, recent };
}

const THEMES = {
  dark: {
    bg: "#091018", border: "#15212e", fg: "#e8f1fb", muted: "#8fa3b8", accent: "#f2a54a",
    series: ["#6d9bff", "#34d3a3", "#f2a54a", "#a58bff", "#4cc3e0", "#e57aa6", "#5b6b7d"],
  },
  light: {
    bg: "#f4f9ff", border: "#dbe6f2", fg: "#0c1a2a", muted: "#4a5d72", accent: "#b8620f",
    series: ["#2f5fd0", "#0b7f5e", "#b8620f", "#6a4fd6", "#0b7f99", "#b83a74", "#5b6b7d"],
  },
};

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n2 = (n) => Number(n.toFixed(2));

function renderCard(theme, { count, langs, recent }) {
  const t = THEMES[theme];
  // Fonts are 18px+ on a 1000px canvas so text stays legible when a phone scales it down.
  const W = 1000, PAD = 56, BAR_W = W - PAD * 2;
  const sans = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
  const color = (i) => t.series[Math.min(i, t.series.length - 1)];

  // Bar segments; clip to a rounded rect so ends look right.
  let x = PAD;
  const segs = langs.map((l, i) => {
    const w = (l.pct / 100) * BAR_W;
    const s = `<rect x="${n2(x)}" y="130" width="${n2(w)}" height="18" fill="${color(i)}"/>`;
    x += w;
    return s;
  });

  const legend = langs.map((l, i) => {
    const col = i % 4, row = Math.floor(i / 4);
    const lx = PAD + col * 222, ly = 194 + row * 38;
    return `<circle cx="${lx + 7}" cy="${ly - 7}" r="7" fill="${color(i)}"/>` +
      `<text x="${lx + 24}" y="${ly}" font-size="20" fill="${t.fg}">${esc(l.name)} ` +
      `<tspan fill="${t.muted}">${l.pct.toFixed(1)}%</tspan></text>`;
  });

  const recentRows = recent.map((r, i) => {
    const y = 334 + i * 36;
    return `<text x="${PAD}" y="${y}" font-family="${mono}" font-size="20" fill="${t.fg}">${esc(r.name)}</text>` +
      `<text x="${W - PAD}" y="${y}" font-family="${mono}" font-size="20" fill="${t.muted}" text-anchor="end">${r.date}</text>`;
  });

  const H = 334 + (Math.max(recent.length, 1) - 1) * 36 + 40;
  const summary = `${count} public repos. Languages by bytes: ` +
    langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(", ") + ".";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
  <title id="t">Public GitHub activity for ${LOGIN}</title>
  <desc id="d">${esc(summary)}</desc>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${t.bg}" stroke="${t.border}"/>
  <g font-family="${sans}">
    <text x="${PAD}" y="70" font-size="32" font-weight="700" fill="${t.fg}">Public work</text>
    <text x="${W - PAD}" y="70" font-size="20" fill="${t.muted}" text-anchor="end">${count} repos, no forks or archives</text>
    <text x="${PAD}" y="114" font-size="18" fill="${t.accent}" letter-spacing="1">LANGUAGES BY BYTES</text>
    <clipPath id="c"><rect x="${PAD}" y="130" width="${BAR_W}" height="18" rx="9"/></clipPath>
    <g clip-path="url(#c)">${segs.join("")}</g>
    ${legend.join("\n    ")}
    <text x="${PAD}" y="292" font-size="18" fill="${t.accent}" letter-spacing="1">LAST PUSHED</text>
  </g>
  ${recentRows.join("\n  ")}
</svg>
`;
}

// ---------- main ----------

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");

  const [posts, repos] = await Promise.all([fetchPosts(), fetchRepos(token)]);
  const summary = summarize(repos);

  const readmePath = path("README.md");
  const readme = await readFile(readmePath, "utf8");
  const updated = replaceBlock(readme, renderBlog(posts));

  await writeFile(readmePath, updated);
  for (const theme of Object.keys(THEMES)) {
    await writeFile(path(`assets/activity-${theme}.svg`), renderCard(theme, summary));
  }
  console.log(`blog: ${posts.length} posts; activity: ${summary.count} repos, ${summary.langs.length} languages`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
