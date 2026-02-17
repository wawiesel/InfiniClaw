# TopTierMeetingSummary Skill

## Purpose

Extract conference presentation PDFs and organize them into an Obsidian vault with:
1. Full text extraction (docling + PyMuPDF hybrid)
2. Thematic thread organization
3. Proper bidirectional wikilinks
4. Clean, navigable structure

## Workflow

### Phase 1: Extract PDFs (Two Methods)

**Method A: Docling (Preferred for quality)**
- Produces high-quality markdown with images
- OCR support for scanned documents
- Better formatting preservation
- May have naming inconsistencies

**Method B: PyMuPDF (Reliable fallback)**
- 100% success rate on malformed PDFs
- Simple page-by-page text extraction
- Consistent naming (preserves PDF filenames)
- No images

**Recommendation:** Run both, then consolidate.

### Phase 2: Consolidate Extractions

If you ran both docling and PyMuPDF:

1. **Prefer docling content** (better quality, has images)
2. **Keep PyMuPDF naming** (consistent with PDF filenames)
3. **Merge backlinks** from both sources
4. **Use intelligent matching** (keyword-based filename matching)

**Consolidation approach:**
- Read first 50 lines of files to match content
- Use filename keyword matching as fallback
- Copy docling's `_images/` directory
- Update all backlink paths to final directory

### Phase 3: Define Threads

Create thread documents in `Threads/` directory:
- `AI_ML.md`
- `Fission_Product_Yields.md`
- `Activation_Data.md`
- etc.

Each thread document should have:
- Overview of the topic
- Key presentations section (manually curated)
- Key insights
- Connections to people/institutions
- Open questions
- Follow-up actions

### Phase 4: Map Presentations to Threads

Use `create_thread_mapping.py` to analyze content and map presentations to threads:

```bash
python3 create_thread_mapping.py <extracted_dir> <threads_dir>
```

**Output:**
- `Thread_Mapping.md` - Complete mapping report
- Keyword-based matching
- Match scores for each presentation

### Phase 5: Add Backlinks

Use `add_thread_backlinks.py` to add bidirectional links:

```bash
python3 add_thread_backlinks.py <extracted_dir> <mapping_file>
```

**Output:**
- Adds "Related Threads" section to each extracted presentation
- Uses proper Obsidian wikilinks: `[[Threads/AI_ML]]`
- Enables graph view navigation

### Phase 6: Clean Integration

Update thread documents with clean footer:

```markdown
---

**Note:** All extracted presentations with [topic] content have backlinks to this thread. See [[../Extracted/]] for full collection.
```

Create index file in extracted directory with browse-by-thread navigation.

## Best Practices

1. **Run both extractors** - Docling for quality, PyMuPDF for reliability
2. **Consolidate intelligently** - Match by content, not just filename
3. **Prefer docling content** - Better formatting and images
4. **Keep consistent naming** - Use original PDF filenames
5. **Manual thread curation** - Automation finds related, you curate key presentations
6. **Bidirectional links** - Thread → Presentations and Presentations → Threads
7. **Graph view friendly** - All wikilinks work in Obsidian

## Example Structure

```
Meetings/CONFERENCE_2026/
├── Presentations/           # Original PDFs
├── Extracted/              # Consolidated markdown
│   ├── INDEX.md
│   ├── _images/            # From docling
│   ├── 2026-CONF-Topic1.md (docling content + backlinks)
│   └── 2026-CONF-Topic2.md (docling content + backlinks)
├── Threads/
│   ├── AI_ML.md
│   └── Fission_Product_Yields.md
└── Thread_Mapping.md       # Automated mapping report
```

## Scripts

### extract_with_pymupdf.py

Extracts all PDFs in a directory to markdown using PyMuPDF (fitz):
- Handles malformed PDFs
- Page-by-page extraction
- Metadata preservation

### create_thread_mapping.py

Analyzes extracted content and maps to threads:
- Keyword matching
- Scoring system (2+ matches = relevant)
- Generates mapping report

### add_thread_backlinks.py

Adds backlinks to extracted presentations:
- Inserts "Related Threads" section
- Uses Obsidian wikilink format
- Preserves existing content

## Consolidation Process

When you have both docling and PyMuPDF extractions:

1. **Match files** by comparing first 50 lines
2. **Fallback** to keyword-based filename matching
3. **Combine:**
   - Take docling content (full)
   - Append PyMuPDF backlinks section
   - Save as PyMuPDF filename (consistent)
4. **Copy images** from docling `_images/`
5. **Update paths** in all wikilinks

## Lessons Learned

1. **Hybrid approach is best** - Docling for quality + PyMuPDF for coverage
2. **Intelligent consolidation** - Don't duplicate, merge best of both
3. **Manual thread curation** is essential - automation finds related content
4. **Backlinks enable discovery** - Graph view becomes powerful
5. **Clean integration** - Don't clutter thread docs with auto-generated lists
6. **Index files** - Provide entry points for browsing
7. **Consistent naming** - Preserve PDF filenames for clarity

## Dependencies

- Python 3.8+
- PyMuPDF (pip install pymupdf)
- Docling (optional, pip install docling)
- Obsidian vault structure

## Created By

Johnny5, Commander - February 16, 2026
Developed during WANDA 2026 proceedings extraction project
Refined with hybrid docling + PyMuPDF consolidation approach
