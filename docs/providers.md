# Provider setup

Install and sign in to at least one supported agent before using MonoCode. MonoCode runs the CLIs you install and reuses their existing logins.

Follow each provider’s linked installation guide for platform requirements and installation options. Use the installation and login commands below where provided.

- [Claude Code](https://claude.com/product/claude-code) - `claude auth login`
- [Codex](https://developers.openai.com/codex/cli) - `codex login`
- [Cursor CLI](https://cursor.com/cli) - `agent login`
- [Grok Build](https://docs.x.ai/build/overview) - `curl -fsSL https://x.ai/cli/install.sh | bash` then `grok login`
- [OpenCode](https://opencode.ai) - `opencode auth login`
- [Antigravity](https://antigravity.google/docs/cli-install) (macOS/Linux) - `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then run `agy` once to sign in
- [Pi](https://pi.dev/) - `npm install -g @earendil-works/pi-coding-agent`
- [omp](https://omp.sh) - `curl -fsSL https://omp.sh/install | sh`
- [fx](https://fx.sh) - `curl -fsSL https://fx.sh/setup.sh | bash` then `fx login`
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) - macOS/Linux: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`; Windows PowerShell: `iex (irm https://hermes-agent.nousresearch.com/install.ps1)`; then run `hermes model`
- [Devin CLI](https://docs.devin.ai/cli) - macOS/Linux: `curl -fsSL https://cli.devin.ai/install.sh | bash` (or `brew install --cask devin-cli`); Windows PowerShell: `irm https://static.devin.ai/cli/setup.ps1 | iex`; then run `devin auth login` (MonoCode reuses that login)

One provider is enough. MonoCode probes for each CLI at startup and disables the ones it can’t find, with a hint about how to install them, so a missing Codex doesn’t stop you from working on anything else.

Once a provider is installed and signed in, open a project folder in MonoCode, choose that agent, and send a message. For sessions on another machine, install and authenticate the providers on the host as described in [remote access](remote-access.md).

To run MonoCode from a checkout, see [building from source](building.md). Return to the [README](../README.md) for desktop downloads.
## Continuing with another provider

Switching providers carries selected original conversation text into the new
provider session. MonoCode prioritizes the original request and recent dialogue,
then includes plans, task lists, CI context and tool outcomes as space permits.
Selected records retain their full text and chronological order, including partial
answers from interrupted turns. Your new request is sent separately and is never
shortened to fit the history. Switching no longer asks the outgoing provider to
generate a recap.

When history does not fit, MonoCode saves its text as a local JSONL attachment and
tells the receiving agent where to read or search it with its normal file tools.
This does not enable `/operator`. Normal provider file-access restrictions still
apply. The snapshot uses temporary attachment storage and may be removed by OS
cleanup; the saved conversation remains in MonoCode. A snapshot larger than 20 MiB
or a failed write stops the send with an error instead of silently losing context.

The inline selection has a 16,000-byte budget including JSON encoding. Until the
new provider reports its capacity, budgeting assumes a 128,000-token window,
conservatively charges text by UTF-8 bytes, reserves 32,000 for instructions, tools
and output, and reserves 8,192 per new attachment. These are estimates: smaller
or custom model windows can still reject a request. Reasoning, historical
attachments and native tool state are not transferred.

Continuing from a selected turn in another pane reads the source conversation only
through that turn. Keep that source conversation until the first message is sent.
Older saved handoff drafts that contain only a recap continue using that recap.
This applies to local desktop provider switches; remote host sessions retain their
existing behavior.
