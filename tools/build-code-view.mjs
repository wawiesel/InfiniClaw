#!/usr/bin/env node

import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import { marked } from 'marked';

const ROOT = process.cwd();
const SITE_NAME = process.env.CODEVIEW_SITE_NAME ?? 'beacon';
const SITE_SOURCE_ROOT = path.join(ROOT, process.env.CODEVIEW_SOURCE_ROOT ?? 'beacon');
const CODE_VIEW_ROOT = path.join(ROOT, 'docs', SITE_NAME);
const SKIP_DIRS = new Set([
  '.git',
  '.tmp',
  '_runtime',
  'coverage',
  'dist',
  'docs',
  'external',
  'node_modules',
  'prototype',
]);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function getBranchName() {
  if (process.env.CODEVIEW_VERSION) {
    return process.env.CODEVIEW_VERSION;
  }
  const branch = childProcess
    .execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf-8' })
    .trim();
  return branch === 'HEAD'
    ? childProcess.execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf-8' }).trim()
    : branch;
}

function sanitizeVersion(version) {
  return version.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readText(file) {
  return fs.readFileSync(file, 'utf-8');
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text);
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function normalizePath(file) {
  return file.split(path.sep).join('/');
}

function relativeFromRoot(file) {
  return normalizePath(path.relative(ROOT, file));
}

function relativeFromSiteRoot(file) {
  return normalizePath(path.relative(SITE_SOURCE_ROOT, file));
}

function getMatchingSourceFile(dir, piece) {
  for (const extension of SOURCE_EXTENSIONS) {
    const sourceFile = path.join(dir, `${piece}${extension}`);
    const testFile = path.join(dir, `${piece}.test${extension}`);
    if (fs.existsSync(sourceFile) && fs.existsSync(testFile)) {
      return { sourceFile, testFile, extension };
    }
  }
  return null;
}

function collectEntries(dir, entries) {
  const dirents = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of dirents) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
      continue;
    }
    const fullDir = path.join(dir, entry.name);
    const readmeFile = path.join(fullDir, 'README.md');
    const sourceMatch = getMatchingSourceFile(fullDir, entry.name);
    if (fs.existsSync(readmeFile) && sourceMatch) {
      const relativeDir = relativeFromSiteRoot(fullDir);
      entries.push({
        directory: relativeDir,
        displayName: entry.name,
        group: normalizePath(path.dirname(relativeDir)),
        sourceFile: sourceMatch.sourceFile,
        testFile: sourceMatch.testFile,
        readmeFile,
        extension: sourceMatch.extension,
      });
      continue;
    }
    collectEntries(fullDir, entries);
  }
}

function lineCount(source) {
  return source.split('\n').length;
}

function ccnEstimate(source) {
  const matches = source.match(/\b(if|for|while|case|catch|switch)\b|\?\s|&&|\|\|/g);
  return 1 + (matches?.length ?? 0);
}

function extractComments(source) {
  const lines = source.split('\n');
  const comments = [];
  let inBlock = false;
  let buffer = [];
  let startLine = 0;

  lines.forEach((line, index) => {
    const no = index + 1;
    const trimmed = line.trim();

    if (!inBlock && (trimmed.startsWith('/**') || trimmed.startsWith('/*'))) {
      inBlock = true;
      startLine = no;
      buffer = [trimmed.replace(/^\/\*\*?/, '').replace(/\*\/$/, '').trim()];
      if (trimmed.endsWith('*/')) {
        inBlock = false;
        comments.push({ line: startLine, text: buffer.join('\n').trim() });
        buffer = [];
      }
      return;
    }

    if (inBlock) {
      buffer.push(trimmed.replace(/\*\/$/, '').replace(/^\*\s?/, '').trim());
      if (trimmed.endsWith('*/')) {
        inBlock = false;
        comments.push({ line: startLine, text: buffer.join('\n').trim() });
        buffer = [];
      }
      return;
    }

    if (trimmed.startsWith('//')) {
      comments.push({ line: no, text: trimmed.replace(/^\/\/\s?/, '').trim() });
    }
  });

  return comments.filter((entry) => entry.text.length > 0);
}

function stripCommentsForCodeView(source) {
  const lines = source.split('\n');
  const output = [];
  let inBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (inBlock) {
      output.push('');
      if (trimmed.endsWith('*/')) {
        inBlock = false;
      }
      continue;
    }

    if (trimmed.startsWith('/**') || trimmed.startsWith('/*')) {
      output.push('');
      if (!trimmed.endsWith('*/')) {
        inBlock = true;
      }
      continue;
    }

    if (trimmed.startsWith('//')) {
      output.push('');
      continue;
    }

    output.push(line);
  }

  return output.join('\n');
}

function renderCode(source) {
  return source
    .split('\n')
    .map((line, index) => {
      const number = String(index + 1).padStart(4, ' ');
      return `<div class="code-line"><span class="line-no">${number}</span><span class="line-src">${escapeHtml(line)}</span></div>`;
    })
    .join('\n');
}

function renderComments(comments) {
  if (comments.length === 0) {
    return '<div class="empty-state">No inline commentary extracted from the source file.</div>';
  }
  return comments.map((comment) => (
    `<article class="comment-card"><div class="comment-line">line ${comment.line}</div><div class="comment-text">${escapeHtml(comment.text)}</div></article>`
  )).join('\n');
}

function buildPathTree(entries) {
  const root = { children: new Map(), entry: null };

  for (const entry of entries) {
    const parts = entry.directory.split('/').filter(Boolean);
    let node = root;
    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, children: new Map(), entry: null });
      }
      node = node.children.get(part);
    }
    node.entry = entry;
  }

  return root;
}

function renderTreeNode(node, currentDirectory, versionRoot, pageDir) {
  const children = Array.from(node.children.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, child]) => renderTreeNode(child, currentDirectory, versionRoot, pageDir))
    .join('\n');

  if (node.entry) {
    const target = path.join(versionRoot, node.entry.directory, 'index.html');
    const href = normalizePath(path.relative(pageDir, target));
    const active = node.entry.directory === currentDirectory ? 'active' : '';
    return `<li class="tree-node tree-leaf"><a class="tree-link ${active}" href="${href}"><span class="tree-name">${escapeHtml(node.name)}</span></a></li>`;
  }

  return `<li class="tree-node tree-folder"><div class="tree-folder-label"><span class="tree-name">${escapeHtml(node.name)}</span></div><ul class="tree-children">${children}</ul></li>`;
}

function buildSidebar(entries, currentDirectory, versionRoot, pageDir) {
  const root = buildPathTree(entries);
  const sections = Array.from(root.children.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, child]) => renderTreeNode(child, currentDirectory, versionRoot, pageDir))
    .join('\n');

  return `<nav class="sidebar-nav"><ul class="tree-root">${sections}</ul></nav>`;
}

function relativeAssetPath(pageDir, versionRoot, assetFile) {
  return normalizePath(path.relative(pageDir, path.join(versionRoot, 'assets', assetFile)));
}

function renderShell({ title, version, sidebar, mainContent, stylesheetHref, scriptHref, brandHref }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${stylesheetHref}">
</head>
<body>
  <div class="docs-shell">
    <aside class="sidebar">
      <a class="brand" href="${brandHref}">
        <span class="brand-mark">IC</span>
        <span>
          <span class="brand-title">InfiniClaw Code View</span>
          <span class="brand-subtitle">version ${escapeHtml(version)}</span>
        </span>
      </a>
      ${sidebar}
    </aside>
    <main class="content">
      ${mainContent}
    </main>
  </div>
  <script src="${scriptHref}"></script>
</body>
</html>`;
}

function renderEntryPage(entry, entries, version, versionRoot) {
  const pageDir = path.join(versionRoot, entry.directory);
  const source = readText(entry.sourceFile);
  const test = readText(entry.testFile);
  const readmeHtml = marked.parse(readText(entry.readmeFile));
  const sourceComments = extractComments(source);
  const sourceDisplay = stripCommentsForCodeView(source);
  const sidebar = buildSidebar(entries, entry.directory, versionRoot, pageDir);
  const stylesheetHref = relativeAssetPath(pageDir, versionRoot, 'code-view.css');
  const scriptHref = relativeAssetPath(pageDir, versionRoot, 'code-view.js');
  const brandHref = normalizePath(path.relative(pageDir, path.join(versionRoot, 'index.html')));
  const sourceCode = renderCode(sourceDisplay);
  const testCode = renderCode(test);
  const pageTitle = `${entry.directory} · Code View`;
  const sourcePath = relativeFromRoot(entry.sourceFile);
  const testPath = relativeFromRoot(entry.testFile);

  const mainContent = `
    <header class="page-header">
      <p class="eyebrow">Code Piece</p>
      <h1>${escapeHtml(entry.displayName)}</h1>
      <p class="lede">${escapeHtml(entry.directory)}</p>
      <div class="stats">
        <span>LOC ${lineCount(source)}</span>
        <span>CCN ${ccnEstimate(source)}</span>
        <span>comments ${sourceComments.length}</span>
        <span>test LOC ${lineCount(test)}</span>
        <span>test CCN ${ccnEstimate(test)}</span>
      </div>
    </header>

    <section class="split-view">
      <article class="panel">
        <header class="panel-header">
          <div>
            <h2>Code</h2>
            <p>${escapeHtml(sourcePath)}</p>
          </div>
        </header>
        <div class="panel-body scroll-panel">
          <div class="code-block sync-scroll" data-sync-group="piece">${sourceCode}</div>
        </div>
      </article>

      <article class="panel">
        <header class="panel-header panel-header-tabs">
          <div>
            <h2>Details</h2>
            <p id="right-pane-label">${escapeHtml(sourcePath)}</p>
          </div>
          <div class="tab-row" role="tablist" aria-label="Right pane view">
            <button class="tab-button active" data-target="commentary" type="button">Commentary</button>
            <button class="tab-button" data-target="test" type="button">Test File</button>
          </div>
        </header>
        <div class="panel-body">
          <section class="tab-panel active scroll-panel sync-scroll" data-panel="commentary" data-sync-group="piece">
            ${renderComments(sourceComments)}
          </section>
          <section class="tab-panel tab-panel-code scroll-panel sync-scroll" data-panel="test" data-sync-group="piece">
            <div class="code-block">${testCode}</div>
          </section>
        </div>
      </article>
    </section>

    <section class="panel readme-panel">
      <header class="panel-header">
        <div>
          <h2>README.md</h2>
          <p>${escapeHtml(relativeFromRoot(entry.readmeFile))}</p>
        </div>
      </header>
      <div class="panel-body prose">
        ${readmeHtml}
      </div>
    </section>

    <script type="application/json" id="page-metadata">${escapeHtml(JSON.stringify({
      commentaryLabel: sourcePath,
      testLabel: testPath,
    }))}</script>
  `;

  return renderShell({
    title: pageTitle,
    version,
    sidebar,
    mainContent,
    stylesheetHref,
    scriptHref,
    brandHref,
  });
}

function renderVersionIndex(entries, version, versionRoot) {
  const pageDir = versionRoot;
  const sidebar = buildSidebar(entries, '', versionRoot, pageDir);
  const stylesheetHref = normalizePath(path.join('assets', 'code-view.css'));
  const scriptHref = normalizePath(path.join('assets', 'code-view.js'));
  const brandHref = 'index.html';
  const byGroup = new Map();
  for (const entry of entries) {
    const list = byGroup.get(entry.group) ?? [];
    list.push(entry);
    byGroup.set(entry.group, list);
  }

  const sections = Array.from(byGroup.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, groupEntries]) => {
      const links = groupEntries
        .sort((left, right) => left.displayName.localeCompare(right.displayName))
        .map((entry) => (
          `<li><a href="${normalizePath(path.join(entry.directory, 'index.html'))}">${entry.displayName}</a></li>`
        ))
        .join('\n');
      return `<section class="panel landing-panel"><header class="panel-header"><div><h2>${escapeHtml(group)}</h2><p>${groupEntries.length} code piece${groupEntries.length === 1 ? '' : 's'}</p></div></header><div class="panel-body"><ul class="landing-list">${links}</ul></div></section>`;
    })
    .join('\n');

  const mainContent = `
    <header class="page-header">
      <p class="eyebrow">Code View</p>
      <h1>InfiniClaw implementation pages</h1>
      <p class="lede">This site renders every code piece that follows the one-piece-per-directory rule: \`piece/README.md\`, \`piece.ts\`, and \`piece.test.ts\`.</p>
      <div class="stats">
        <span>site ${escapeHtml(SITE_NAME)}</span>
        <span>branch ${escapeHtml(version)}</span>
        <span>pieces ${entries.length}</span>
      </div>
    </header>
    ${sections}
  `;

  return renderShell({
    title: `InfiniClaw Code View · ${version}`,
    version,
    sidebar,
    mainContent,
    stylesheetHref,
    scriptHref,
    brandHref,
  });
}

function renderStylesheet() {
  return `
:root {
  --bg: #f7f7f5;
  --panel: #ffffff;
  --line: #d8dfdf;
  --line-strong: #c2cccd;
  --text: #22323f;
  --muted: #657886;
  --accent: #0b5d7a;
  --accent-soft: #dff0f8;
  --code-bg: #0f1720;
  --code-line: #15202c;
  --code-text: #e9eff3;
  --code-muted: #7d93a7;
  --shadow: 0 10px 30px rgba(18, 33, 42, 0.06);
  --radius: 16px;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 ui-sans-serif, system-ui, sans-serif;
}

a {
  color: var(--accent);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

code {
  background: #eef2f2;
  border-radius: 6px;
  padding: 0.12rem 0.35rem;
  font: 0.92em ui-monospace, SFMono-Regular, Menlo, monospace;
}

pre {
  background: #edf2f4;
  border-radius: 12px;
  overflow: auto;
  padding: 16px;
}

.docs-shell {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  min-height: 100vh;
}

.sidebar {
  background: #fbfcfb;
  border-right: 1px solid var(--line);
  padding: 20px 18px 28px;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow: auto;
}

.brand {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 22px;
  color: var(--text);
  text-decoration: none;
}

.brand:hover {
  text-decoration: none;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 12px;
  background: var(--accent);
  color: white;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.brand-title,
.brand-subtitle {
  display: block;
}

.brand-title {
  font-weight: 700;
}

.brand-subtitle {
  color: var(--muted);
  font-size: 13px;
}

.sidebar-nav,
.tree-root,
.tree-children {
  margin: 0;
  padding: 0;
  list-style: none;
}

.tree-root {
  font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
}

.tree-node {
  margin: 0;
}

.tree-folder-label,
.tree-link {
  display: block;
  border-radius: 10px;
  color: var(--text);
  padding: 6px 8px;
  position: relative;
}

.tree-folder-label {
  color: var(--muted);
  font-weight: 600;
}

.tree-folder-label::before {
  content: "▾";
  display: inline-block;
  width: 1rem;
  color: var(--muted);
}

.tree-children {
  border-left: 1px solid var(--line);
  margin-left: 11px;
  padding-left: 10px;
}

.tree-link::before {
  content: "•";
  display: inline-block;
  width: 1rem;
  color: var(--muted);
}

.tree-link.active,
.tree-link:hover {
  background: var(--accent-soft);
  text-decoration: none;
}

.tree-name {
  min-width: 0;
}

.content {
  padding: 28px;
}

.page-header {
  margin-bottom: 20px;
}

.eyebrow {
  margin: 0 0 8px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.page-header h1 {
  margin: 0;
  font-size: clamp(1.7rem, 2vw, 2.4rem);
  line-height: 1.1;
}

.lede {
  margin: 8px 0 0;
  color: var(--muted);
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}

.stats span {
  background: white;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  padding: 6px 12px;
}

.split-view {
  display: grid;
  gap: 20px;
  grid-template-columns: minmax(0, 1.25fr) minmax(320px, 0.9fr);
  margin-bottom: 20px;
}

.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  background: #fcfdfd;
  border-bottom: 1px solid var(--line);
  padding: 16px 18px;
}

.panel-header h2 {
  margin: 0;
  font-size: 15px;
}

.panel-header p {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 13px;
}

.panel-header-tabs {
  align-items: center;
}

.panel-body {
  padding: 18px;
}

.scroll-panel {
  height: min(72vh, 920px);
  overflow: auto;
}

.code-block {
  background: var(--code-bg);
  color: var(--code-text);
  border-radius: 14px;
  padding: 14px 0;
  font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
}

.code-line {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 12px;
  padding: 0 16px;
  white-space: pre;
}

.line-no {
  color: var(--code-muted);
  text-align: right;
  user-select: none;
}

.line-src {
  color: var(--code-text);
}

.tab-row {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px;
  background: #f4f7f7;
}

.tab-button {
  appearance: none;
  background: transparent;
  border: 0;
  border-radius: 999px;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  padding: 7px 12px;
}

.tab-button.active {
  background: white;
  color: var(--text);
  box-shadow: 0 1px 4px rgba(17, 30, 38, 0.08);
}

.tab-panel {
  display: none;
}

.tab-panel.active {
  display: block;
}

.tab-panel-code .code-block {
  margin: 0;
}

.comment-card {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 12px;
  background: #fbfcfc;
}

.comment-line {
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.comment-text {
  white-space: pre-wrap;
}

.empty-state {
  color: var(--muted);
  padding: 4px 0;
}

.readme-panel {
  margin-top: 20px;
}

.prose > :first-child {
  margin-top: 0;
}

.prose > :last-child {
  margin-bottom: 0;
}

.landing-panel {
  margin-bottom: 20px;
}

.landing-list {
  margin: 0;
  padding-left: 18px;
}

@media (max-width: 1120px) {
  .docs-shell {
    grid-template-columns: 1fr;
  }

  .sidebar {
    position: static;
    height: auto;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .split-view {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .content {
    padding: 18px;
  }

  .panel-header {
    flex-direction: column;
  }

  .tab-row {
    width: 100%;
    justify-content: stretch;
  }

  .tab-button {
    flex: 1 1 0;
    text-align: center;
  }
}
  `.trimStart();
}

function renderScript() {
  return `
document.querySelectorAll('.panel-header-tabs').forEach((header) => {
  const buttons = Array.from(header.querySelectorAll('.tab-button'));
  const panel = header.closest('.panel');
  const label = document.getElementById('right-pane-label');
  const metadataTag = document.getElementById('page-metadata');
  const metadata = metadataTag ? JSON.parse(metadataTag.textContent) : null;
  const panels = panel ? Array.from(panel.querySelectorAll('.tab-panel')) : [];

  function show(target) {
    buttons.forEach((button) => {
      button.classList.toggle('active', button.dataset.target === target);
    });
    panels.forEach((panelElement) => {
      panelElement.classList.toggle('active', panelElement.dataset.panel === target);
    });
    if (!label || !metadata) {
      return;
    }
    label.textContent = target === 'test' ? metadata.testLabel : metadata.commentaryLabel;
  }

  buttons.forEach((button) => {
    button.addEventListener('click', () => show(button.dataset.target));
  });
});

const syncGroups = new Map();

document.querySelectorAll('.sync-scroll').forEach((element) => {
  const group = element.dataset.syncGroup;
  if (!group) {
    return;
  }
  const list = syncGroups.get(group) ?? [];
  list.push(element);
  syncGroups.set(group, list);
});

for (const elements of syncGroups.values()) {
  let syncing = false;

  function visibleElements() {
    return elements.filter((element) => element.offsetParent !== null);
  }

  function syncFrom(source) {
    if (syncing) {
      return;
    }
    const active = visibleElements();
    if (active.length < 2) {
      return;
    }
    const maxScrollTop = Math.max(source.scrollHeight - source.clientHeight, 0);
    const ratio = maxScrollTop === 0 ? 0 : source.scrollTop / maxScrollTop;

    syncing = true;
    try {
      for (const target of active) {
        if (target === source) {
          continue;
        }
        const targetMax = Math.max(target.scrollHeight - target.clientHeight, 0);
        target.scrollTop = targetMax * ratio;
      }
    } finally {
      syncing = false;
    }
  }

  for (const element of elements) {
    element.addEventListener('scroll', () => syncFrom(element));
  }
}
  `.trimStart();
}

function main() {
  const version = getBranchName();
  const versionRoot = CODE_VIEW_ROOT;
  const entries = [];

  collectEntries(SITE_SOURCE_ROOT, entries);
  entries.sort((left, right) => left.directory.localeCompare(right.directory));

  fs.rmSync(CODE_VIEW_ROOT, { recursive: true, force: true });
  ensureDir(path.join(versionRoot, 'assets'));

  writeText(path.join(versionRoot, 'assets', 'code-view.css'), renderStylesheet());
  writeText(path.join(versionRoot, 'assets', 'code-view.js'), renderScript());

  for (const entry of entries) {
    const html = renderEntryPage(entry, entries, version, versionRoot);
    writeText(path.join(versionRoot, entry.directory, 'index.html'), html);
  }

  writeText(path.join(versionRoot, 'index.html'), renderVersionIndex(entries, version, versionRoot));

  console.log(`Built code view → ${normalizePath(path.relative(ROOT, versionRoot))}`);
}

main();
