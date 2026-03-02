#!/usr/bin/env python3
"""Run PDF extraction for karakaxi_natCu_GELINA paper.

Sets up directory structure and runs docling decomposition.
Run from host: python3 ~/2026-Nanoclaw/InfiniClaw/bots/personas/nora/run_extract.py
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


BENCH_ROOT = Path("/Users/ww5/Documents/2026-SCALE_Validation_Candidates/karakaxi_natCu_GELINA")
PDF_SRC    = Path("/Users/ww5/Documents/2026-SCALE_Validation_Candidates/karakaxi_natCu_GELINA.pdf")
DOC_BASE   = "karakaxi_natCu_GELINA"


def ensure(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def rewrite_markdown_image_links(md_path: Path, image_dir: Path) -> None:
    text = md_path.read_text(encoding="utf-8")

    def repl(match: re.Match) -> str:
        ref = match.group(1)
        base = Path(ref).name
        if (image_dir / base).exists():
            return match.group(0).replace(ref, f"_images/{base}")
        return match.group(0)

    text = re.sub(r"!\[[^\]]*\]\(([^)]+)\)", repl, text)
    md_path.write_text(text, encoding="utf-8")


def ensure_figure_triage(triage_path: Path, md_path: Path, image_dir: Path) -> None:
    md_text = md_path.read_text(encoding="utf-8")
    found = re.findall(r"\bFigure\s+([A-Za-z0-9.\-]+)", md_text)
    discovered_ids = sorted({f"Figure {token}" for token in found})

    image_names = sorted(p.name for p in image_dir.glob("*") if p.is_file())

    triage = {
        "triage_method": "risk_based",
        "criteria": [
            "geometry_driver: figure contains dimension callouts affecting cross-section model geometry",
            "data_source: figure shows measured cross-section data, transmission curves, or experimental results",
            "reference_only: figure is informational, schematic, or apparatus photo with no extractable numbers",
            "undecided: not yet classified"
        ],
        "gates": {"allow_undecided": False, "allow_partial_geometry": False},
        "figures": [],
        "no_geometry_driving_figures_reason": ""
    }

    by_id = {}
    for fid in discovered_ids:
        by_id[fid] = {
            "figure_id": fid,
            "artifact": "",
            "role": "undecided",
            "status": "pending",
            "why": "",
            "constraint_adapter": "",
            "solver_output": ""
        }

    if not discovered_ids:
        for idx, name in enumerate(image_names, start=1):
            fid = f"Image {idx}"
            by_id[fid] = {
                "figure_id": fid,
                "artifact": f"references/_images/{name}",
                "role": "undecided",
                "status": "pending",
                "why": "seeded from image extraction; classify manually",
                "constraint_adapter": "",
                "solver_output": ""
            }

    triage["figures"] = sorted(by_id.values(), key=lambda x: str(x.get("figure_id", "")))
    triage_path.write_text(json.dumps(triage, indent=2) + "\n", encoding="utf-8")


def ensure_benchmark_params(spec_path: Path) -> None:
    if spec_path.exists():
        return
    spec = {
        "benchmark_id": DOC_BASE,
        "paper": {
            "title": "Transmission measurements on natCu samples at GELINA",
            "authors": ["Anna Karakaxi", "C. Paradela", "P. Schillebeeckx", "et al."],
            "journal": "HNPS Advances in Nuclear Physics",
            "year": "2025",
            "doi": "",
            "semantic_scholar": "https://www.semanticscholar.org/paper/67129cf4bd29d83a8824039ba0d6a1afe8790a91"
        },
        "relevance": {
            "scale_components": ["AMPX cross sections", "neutron transport"],
            "nuclides": ["Cu-63", "Cu-65", "nat-Cu"],
            "reaction_types": ["neutron transmission", "total cross section"],
            "facility": "GELINA (IRMM/EC-JRC Geel)",
            "priority": "high"
        },
        "source": {
            "pdf": f"references/{DOC_BASE}.pdf",
            "markdown": f"references/{DOC_BASE}.md"
        },
        "figure_triage_file": "references/_extract/figure_triage.json"
    }
    spec_path.write_text(json.dumps(spec, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    if not PDF_SRC.is_file():
        raise SystemExit(f"PDF not found: {PDF_SRC}")

    if shutil.which("docling") is None:
        raise SystemExit("docling not found in PATH")

    # Set up directory structure
    ref  = BENCH_ROOT / "references"
    img  = ref / "_images"
    fig  = ref / "_figures"
    tab  = ref / "_tables"
    ext  = ref / "_extract"
    for d in (img, fig, tab, ext,
              ext / "untrusted_sample_decks",
              ext / "figure_constraints"):
        ensure(d)

    pdf_dst    = ref / f"{DOC_BASE}.pdf"
    md_dst     = ref / f"{DOC_BASE}.md"
    spec_dst   = ext / "benchmark_parameters.json"
    triage_dst = ext / "figure_triage.json"

    # Copy PDF into references/
    if not pdf_dst.exists():
        shutil.copy2(PDF_SRC, pdf_dst)
        print(f"Copied PDF -> {pdf_dst}")

    # Run docling
    print("Running docling...")
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        result = subprocess.run(
            [
                "docling", str(pdf_dst),
                "--to", "md",
                "--image-export-mode", "referenced",
                "--output", str(tmp),
            ],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            print("docling stderr:", result.stderr, file=sys.stderr)
            raise SystemExit(f"docling failed (exit {result.returncode})")

        # Find output markdown
        md_candidates = sorted(tmp.rglob(f"{DOC_BASE}.md")) or sorted(tmp.rglob("*.md"))
        if not md_candidates:
            raise SystemExit("docling produced no markdown output")
        shutil.copy2(md_candidates[0], md_dst)
        print(f"Markdown -> {md_dst}")

        # Copy images
        copied_images = 0
        for p in tmp.rglob("*"):
            if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
                shutil.copy2(p, img / p.name)
                copied_images += 1
        print(f"Images -> {img} ({copied_images} files)")

        # Save raw docling output
        raw = ext / f"docling_raw"
        ensure(raw)
        for p in tmp.rglob("*"):
            if p.is_file():
                rel = p.relative_to(tmp)
                out = raw / rel
                ensure(out.parent)
                shutil.copy2(p, out)

    # Rewrite image links in markdown
    rewrite_markdown_image_links(md_dst, img)

    # Generate metadata files
    ensure_benchmark_params(spec_dst)
    ensure_figure_triage(triage_dst, md_dst, img)

    print(f"\nDone.")
    print(f"  PDF:      {pdf_dst}")
    print(f"  Markdown: {md_dst}")
    print(f"  Images:   {img} ({len(list(img.glob('*')))} files)")
    print(f"  Params:   {spec_dst}")
    print(f"  Triage:   {triage_dst}")


if __name__ == "__main__":
    main()
