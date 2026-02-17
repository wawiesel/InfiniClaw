#!/usr/bin/env python3
"""
Map extracted WANDA 2026 presentations to thematic threads.
Updates thread documents with links to relevant extracted PDFs.
"""

from pathlib import Path
import re

# Define thread mappings based on keywords and topics
thread_mappings = {
    "AI_ML.md": {
        "keywords": ["AI", "ML", "machine learning", "neural", "emulator", "Genesis", 
                     "DEIMOS", "EMU", "UQ_EMU", "ATLAS", "eigenvector", "STREAMLINE",
                     "Bayesian", "deployment"],
        "presentations": []
    },
    "Fission_Product_Yields.md": {
        "keywords": ["FPY", "fission product", "yield", "CGMF", "FREYA", "cumulative",
                     "independent", "fragment", "correlation", "anti-neutrino"],
        "presentations": []
    },
    "Activation_Data.md": {
        "keywords": ["activation", "cosmogenic", "PETALE", "micro", "CALDERA",
                     "inventory", "transmutation", "cross section"],
        "presentations": []
    }
}

# Scan all extracted documents
extracted_dir = Path("Extracted_PyMuPDF")
for md_file in sorted(extracted_dir.glob("*.md")):
    # Read first 200 lines to get content sample
    with open(md_file, 'r', encoding='utf-8') as f:
        content = f.read(50000)  # First ~50KB
    
    content_lower = content.lower()
    
    # Check against each thread
    for thread_name, thread_data in thread_mappings.items():
        matches = sum(1 for kw in thread_data["keywords"] if kw.lower() in content_lower)
        
        if matches >= 2:  # At least 2 keyword matches
            # Map back to PDF name
            pdf_name = md_file.stem + ".pdf"
            thread_data["presentations"].append({
                "pdf": pdf_name,
                "md": md_file.name,
                "matches": matches,
                "title": md_file.stem.replace("2026-WANDA-", "").replace("_", " ")
            })

# Print results
for thread_name, thread_data in thread_mappings.items():
    print(f"\n=== {thread_name} ===")
    print(f"Found {len(thread_data['presentations'])} presentations")
    for pres in sorted(thread_data["presentations"], key=lambda x: x["matches"], reverse=True)[:20]:
        print(f"  [{pres['matches']:2d}] {pres['pdf']}")
        print(f"      {pres['title']}")

# Save detailed mapping
output = []
output.append("# WANDA 2026 Presentation → Thread Mapping\n")
output.append("Generated: February 16, 2026\n\n")

for thread_name, thread_data in thread_mappings.items():
    output.append(f"## {thread_name.replace('.md', '')}\n")
    output.append(f"**Total presentations:** {len(thread_data['presentations'])}\n\n")
    
    for pres in sorted(thread_data["presentations"], key=lambda x: x["matches"], reverse=True):
        output.append(f"- `{pres['pdf']}` ({pres['matches']} keyword matches)\n")
        output.append(f"  - {pres['title']}\n")
        output.append(f"  - Extracted: `Extracted_PyMuPDF/{pres['md']}`\n")
    output.append("\n")

with open("Thread_Mapping.md", 'w', encoding='utf-8') as f:
    f.write("".join(output))

print("\n✓ Wrote Thread_Mapping.md")
