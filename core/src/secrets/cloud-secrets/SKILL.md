---
name: cloud-secrets
description: 'Ask the user for API keys, tokens, or other credentials from a Cloudroom cloud thread and write them to a dotenv file without exposing them in chat.'
---

# Request secrets securely

Use `room-cli secret request` when the user needs to supply a credential. Never ask the user to paste a secret into chat.

Open a form only after the user says they have the value and are ready. One secret per form. If it times out or is cancelled, never reopen it on your own. Ask once, then wait.

Check documentation or `.env.example` for names, but never read or print an existing secret-bearing env file.

```bash
room-cli secret request OPENAI_API_KEY \
  --purpose "Configure application credentials" \
  --describe OPENAI_API_KEY "OpenAI API key used by the server" \
  --write-env .env.local
```

- The user fills a secure form in the thread. The command waits until they submit or cancel, so allow it up to 10 minutes.
- Relative paths resolve from the current folder. The file is written with mode 0600.
- After success, trust the printed path and added/updated/unchanged counts. Never verify with `cat`, `env`, or anything that reveals values.
- If it reports duplicate or multiline assignments, fix the file structure without reading values, then rerun.
- If the request is cancelled, ask in chat whether to try again, then wait for the user's answer. Never ask for the values in chat.
