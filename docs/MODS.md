# Localium server mods and slash commands

Localium `0.2.0` supports declarative modules stored in each hosted server's `mods/` directory. Modules are JSON data, not executable JavaScript. This prevents a downloaded mod from silently importing Node.js modules, reading arbitrary files, or spawning processes.

## Location

Each hosted server stores modules beside its state:

```text
<Localium data root>/servers/<server-id>/mods/
```

Localium creates `README.md` and a disabled `example-welcome.json` on first start.

## Format

```json
{
  "id": "organization.helpdesk",
  "name": "Helpdesk commands",
  "enabled": true,
  "commands": [
    {
      "name": "ticket",
      "description": "Post the internal ticket instructions.",
      "permission": "send_messages",
      "response": "{{user}} requested help for {{args}}. Contact extension 204."
    }
  ]
}
```

Supported templates are `{{user}}`, `{{server}}`, `{{args}}`, and positional values such as `{{arg0}}`. Command names are lowercase ASCII letters, digits, `_`, or `-`. Each command may require any Localium role permission. The server validates the permission before returning the configured response.

After editing files, use **Administration → Server mods → Reload mods**. Invalid, duplicate, oversized, or permission-unknown modules are rejected without partially replacing the active registry.

## Privacy boundary

The slash command name and arguments are processed by the self-hosted server because the server enforces command permissions. The returned result is then encrypted by the invoking client and posted as an end-to-end encrypted system message. Do not place secrets in command arguments unless the server host is trusted to process them.
