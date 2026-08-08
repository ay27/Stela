# Keyboard shortcuts

`Mod` is Command on macOS and Control on Windows/Linux. Stela intentionally
lists product-defined shortcuts here, not the standard text-editing or
CodeMirror navigation keys supplied by the platform.

## Workspace

| Shortcut | Action |
|----------|--------|
| `Mod+K` | Open or close the command palette |
| `Mod+N` | Create a Stela note |
| `Mod+W` | Close the current tab |
| `Mod+Shift+T` | Reopen the most recently closed tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Move forward/backward through tabs by recent use |
| `Escape` | Cancel while the tab switcher is open |
| `Mod+1` … `Mod+9` | Switch to the nth tab |
| `Mod+[` / `Mod+]` | Navigate backward/forward in document history |
| `Mod+,` | Open Settings |
| `Mod+Shift+E` | Reveal the current file in the file tree |
| `Mod+Shift+A` | Expand and focus the Agent panel |
| `Mod+Shift+S` | Insert a RunSQL block at the editor cursor |
| `Mod+I` | Add the current selection or RunSQL block to Agent chat |
| `Mod+Enter` | Run the focused RunSQL block |

## Find and replace

| Shortcut | Action |
|----------|--------|
| `Mod+F` | Find in the current document |
| `Mod+Alt+F` | Find and replace in the current document |
| `Mod+Shift+F` | Search the current Vault |
| `Enter` / `Shift+Enter` | Next/previous match in the find field |
| `Enter` | Replace the current match from the replacement field |
| `Shift+Enter` / `Mod+Enter` | Replace all from the replacement field |
| `Escape` | Close the find bar |

## RunSQL editor

| Shortcut | Action |
|----------|--------|
| `Mod+Enter` | Run the current SQL block |
| `Mod+R` | Reload the current result without rerunning SQL |
| `Mod+Alt+L` | Format the current SQL block |
| `Mod+Alt+T` | Search and insert a SQL template |
| `Tab` | Accept a visible SQL inline-completion suggestion |
| `Escape` | Dismiss a visible SQL inline-completion suggestion |

## Template variables

| Shortcut | Action |
|----------|--------|
| `Tab` / `Shift+Tab` | Move forward/backward through active template variables |
| `Escape` | End active template-variable editing |

Repeated template-variable names are selected and edited together. While a
normal SQL completion popup is open, use `Enter` to accept it; this leaves
`Tab` available for template variables.

## Image preview

| Shortcut | Action |
|----------|--------|
| `+` / `=` | Zoom in |
| `-` / `_` | Zoom out |
| `0` / `R` | Reset zoom and position |
| `Escape` | Close the preview |
