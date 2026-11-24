Set a global default in Settings → Prompts → Custom instructions. Use **Add instructions** to select a harness and either **All models** or one model. Each target has one editable rule. Turning the plugin off keeps the saved text.

Local and Cloud threads receive the global text, then the matching harness rule, then the matching model rule. Each part is optional. The combined text can contain up to 4,096 characters. Changes reach the next eligible message.

## CLI

- `room-cli instructions get|set|clear` reads, changes, or clears the global text.
- `room-cli instructions list --json` lists the saved rules.
- `room-cli instructions set-rule <harness> <model> <text...>` creates or updates a rule. Use a quoted `'*'` for all models.
- `room-cli instructions clear-rule <harness> <model>` removes that rule.
