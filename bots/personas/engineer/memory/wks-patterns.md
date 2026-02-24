# WKS Implementation Patterns

## Adding a New Command

WKS uses a layered architecture: API → CLI → MCP (auto-discovered)

### File Structure
```
wks/api/<domain>/
  schema.json      # Pydantic output schema
  __init__.py      # SchemaLoader.register_from_package
  cmd.py           # Core API function returning StageResult
  <Domain>Config.py # Optional config section

wks/cli/<domain>.py  # Typer factory function
```

### Key Components

1. **StageResult pattern** - API functions return `StageResult(announce=..., progress_callback=do_work)` where `do_work` yields `(float, str)` tuples for progress

2. **Config sections** - Add to `WKSConfig.py`:
   - Import the config class
   - Add field with default: `mv: MvConfig = MvConfig()`
   - Add to `to_dict()` method

3. **CLI registration** - In `_create_app.py`:
   - Import: `from wks.cli.mv import mv`
   - Register: `app.add_typer(mv(), name="mv")`

4. **MCP auto-discovery** - Commands in `wks/api/{domain}/cmd.py` are automatically exposed as MCP tools

### wks mv Specific Rules
- No overwriting (dest must not exist)
- `mv.always_allow_sources` bypasses source monitoring check
- Git-tracked files cannot be moved
- Renamed files must follow `YYYY[-MM[-DD]]-Title_Here.ext` format

### MCP Type Coercion
**IMPORTANT**: MCP tools receive string arguments, not typed objects. API `cmd()` functions must handle both:
```python
def cmd(source: URI | str, dest: URI | str) -> StageResult:
    source_uri = URI(source) if isinstance(source, str) else source
    dest_uri = URI(dest) if isinstance(dest, str) else dest
```

## InfiniClaw Mounts

Mounts are controlled by `~/.config/infiniclaw/allow-list.json`, NOT container-config.json. The `!allow` command updates the NanoClaw allowlist at `~/.config/nanoclaw/mount-allowlist.json` — different file. Captain must manually add permanent mounts to the InfiniClaw allowlist.
