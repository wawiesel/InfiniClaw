# InfiniClaw Design

## Purpose

InfiniClaw is a multi-bot orchestration layer built on a maintained NanoClaw fork. It provides cooperating bots on Matrix:

There are intended to be 3 rooms:

1. The Bridge - where the captain gives orders to commander
2. Engineering - where the engineer works
3. Holodeck - where new bots can be tested

Bots have roles and personas. Currently there are two bots:
- `engineer` is **Cid** — chief engineer, infra + operations + lifecycle control
- `commander` is **Johnny5** — commander, takes orders and executes tasks


## Roles

### Commander
- Responsible for exploring the file system, executing tasks, and reporting back to the captain
- Can modify his own persona CLAUDE.md, skills, and MCP
- Cannnot modify another bot's persona, skills, or MCP
- Has write access to the knowledge vault
- Uses WKS MCP tools to manipulate/explort file system and connect in the knowledge vault
- Has read access to entire home directory

### Engineer 
- Responsible for Infiniclaw codebase including updating nanoclaw underneath our updates
- Responsible for maintaining bot containers
- Can modify his own persona CLAUDE.md, skills, and MCP
- Can modify another bot's persona, skills, and MCP
- Can deploy and test new bots on the Holodeck
- Has read access to entire home directory
- Has write access to the Infiniclaw codebase

## Core Principles

- Use everything from Nanoclaw possible
- We layer our own logic on top of Nanoclaw
  - We use Matrix for communication
  - We use Podman for container management
  - We use WKS MCP tools for file system manipulation
- We have the lobe concept where a bot can spawn a delegate agent that merges back into the main bot using Matrix threads
- Bots must be responsive at all times. Matrix features like emoji and reactions help with this.
- The base bot is Claude based and can upgrade/downgrade his brain by himself.

### Lobes (delegate agents)

Bots can spawn delegate "lobes" for parallel execution. These are **not separate personas**, but rather **multitasking threads** that operate alongside the main bot:
- `delegate_codex` — OpenAI Codex for scoped file operations
- `delegate_gemini` — Google Gemini for research and analysis
- `delegate_ollama` — Local Ollama models for lightweight tasks

Lobe output is streamed to chat and returned to the main brain for integration. While currently underutilized, the lobes system is intended to be an active part of the robust architecture.


### Security

Where is env and secrets maintained

## Code Structure (key classes)

