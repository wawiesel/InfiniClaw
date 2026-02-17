#!/usr/bin/env python3
"""
Add proper backlinks and metadata to extracted presentations.
"""

from pathlib import Path

# Define thread mappings (topic areas)
thread_map = {
    "AI_ML": ["Rare_Isotope_Beams", "InverseUncertaintyQuantificationwith_MachineL", 
              "RECENT_DEPLOYMENT_OF_AI_ML_TOOLS", "UQ_EMU_Machine_Learning",
              "AI_ML_Experimental_Design", "AI_Program_Overview", "DEIMOS_BRAIN",
              "Sparse_Bayesian_Methods", "Dynamic_UQ_Bayesian_Model"],
    "Fission_Product_Yields": ["FPY_Modeling", "Fission_Session_Overview", 
                                "FPY_Measurements", "FPY_Needs", "FPY_Correlations",
                                "Uncertainty_Quantification_in_Fission_Fragmen",
                                "Stockpile_Science_Fission", "ORNL_Inventory_UQ"],
    "Activation_Data": ["High_Precision_Gamma_Ray_Decay_Data", "Inventory_Sub_Library",
                        "MicroCALDERA_Active_Target", "Benchmarking_and_validating_cosmogenic_activa",
                        "PETALE_Benchmark", "ORNL_Inventory_UQ"]
}

# Invert to get file -> threads mapping
file_to_threads = {}
for thread, files in thread_map.items():
    for f in files:
        if f not in file_to_threads:
            file_to_threads[f] = []
        file_to_threads[f].append(thread)

# Process each extracted markdown
extracted_dir = Path("Extracted_PyMuPDF")
updated = 0

for md_file in sorted(extracted_dir.glob("2026-WANDA-*.md")):
    # Read current content
    with open(md_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    # Check if already has backlinks
    if any("Related Threads:" in line for line in lines):
        continue
    
    # Get file stem without prefix
    file_key = md_file.stem.replace("2026-WANDA-", "")
    
    # Find matching threads
    threads = file_to_threads.get(file_key, [])
    
    if not threads:
        continue
    
    # Find where to insert (after the Source/Pages header section)
    insert_idx = 0
    for i, line in enumerate(lines):
        if line.startswith("---") and i > 0:
            insert_idx = i + 1
            break
    
    # Create backlink section
    backlinks = "\n**Related Threads:**\n"
    for thread in threads:
        backlinks += f"- [[Threads/{thread}]]\n"
    backlinks += "\n"
    
    # Insert backlinks
    lines.insert(insert_idx, backlinks)
    
    # Write back
    with open(md_file, 'w', encoding='utf-8') as f:
        f.writelines(lines)
    
    updated += 1
    print(f"✓ {md_file.name} → {', '.join(threads)}")

print(f"\n✓ Updated {updated} files with thread backlinks")
