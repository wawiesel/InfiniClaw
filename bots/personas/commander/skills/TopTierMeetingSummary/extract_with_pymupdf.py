#!/usr/bin/env python3
import fitz
import os
import sys
from pathlib import Path

pdf_dir = Path("Presentations")
output_dir = Path("Extracted_PyMuPDF")
output_dir.mkdir(exist_ok=True)

pdfs = sorted(pdf_dir.glob("*.pdf"))
print(f"Found {len(pdfs)} PDFs to process")

success = 0
failed = []

for pdf_path in pdfs:
    output_name = pdf_path.stem + ".md"
    output_path = output_dir / output_name
    
    try:
        doc = fitz.open(pdf_path)
        
        # Extract text from all pages
        full_text = []
        for page_num in range(len(doc)):
            page = doc[page_num]
            text = page.get_text()
            if text.strip():
                full_text.append(f"# Page {page_num + 1}\n\n{text}")
        
        # Write to markdown
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(f"# {pdf_path.stem}\n\n")
            f.write(f"**Source:** `{pdf_path.name}`\n\n")
            f.write(f"**Pages:** {len(doc)}\n\n")
            f.write("---\n\n")
            f.write("\n\n".join(full_text))
        
        doc.close()
        success += 1
        print(f"✓ {pdf_path.name}")
        
    except Exception as e:
        failed.append((pdf_path.name, str(e)))
        print(f"✗ {pdf_path.name}: {e}")

print(f"\n=== Summary ===")
print(f"Success: {success}/{len(pdfs)}")
print(f"Failed: {len(failed)}")

if failed:
    print("\nFailed PDFs:")
    for name, error in failed:
        print(f"  - {name}: {error}")
