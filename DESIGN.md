# InfiniClaw Design Notes

## Startup Checklist

Sent automatically to each bot's main room on every boot, wrapped in a collapsible `<details>` block so it doesn't dominate the timeline.

### Sections by role

| Section | All bots | Engineer only | Navigator only |
|---------|----------|---------------|----------------|
| Skills | ✅ | ✅ | ✅ |
| MCP Servers | ✅ | ✅ | ✅ |
| Active Todos | ✅ | ✅ | ✅ |
| Machine Health | — | ✅ (named machine) | — |
| Weekly Goals | — | — | ✅ |
| Knowledge Search (latest entry) | — | — | ✅ |

### Rules

- **All bots** show: Skills table, MCP Servers table, Active Todos table.
- **Engineers** additionally show a Machine Health table. The table header must name the machine explicitly (e.g. `🏥 Machine Health — HERACLES`). Engineers are always in Engineering rooms.
- **Navigators** additionally show:
  1. The Captain's global weekly goal list.
  2. The latest entry from a knowledge search (most recently updated knowledge base item).
- The entire checklist is wrapped in a `<details><summary>` block so it collapses by default.

### Collapsible format

```html
<details>
<summary>🚀 Cid startup checklist</summary>

### 🔧 Skills
...tables...

</details>
```
