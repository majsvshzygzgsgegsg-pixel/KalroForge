# The KairoForge conversation vault

Every conversation you have through the harness is captured permanently, and
later conversations start already knowing what came before.

```
YOU ──> HARNESS ──> conversation ──> VAULT (local SQLite, append-only)
                                      │
                                      ├─> measured style profile
                                      ├─> searchable history
                                      └─> training pairs for KairoForge

NEW CONVERSATION ──> vault memory block ──> system prompt
```

---

## What it does

**Records everything.** Every user message and every model reply, with the
model that produced it. Append-only: entries are never rewritten, so the
history stays trustworthy.

**Learns how you write.** The style profile is *measured* from your real
messages, not guessed:

```
messages_analysed     : 706
avg_words_per_message : 182.44
avg_sentence_length   : 8.76
question_rate         : 0.127
top_terms             : agent, test, tools, task, model, tool, browser, local...
common_openers        : "task:", "continue where u last kicked off", ...
formality             : detailed
directness            : direct
```

**Injects that into new conversations.** At the start of each session the
measured profile is added to the system prompt, so the assistant begins
already matching your register instead of defaulting to a generic voice.

**Feeds the model.** Vault conversations export as instruction/response
pairs, so what you actually asked and what the model actually answered can
become fine-tuning data.

---

## Verified live

| Check | Result |
| --- | --- |
| Sessions decoded | **112 logs, 32,314 events** |
| Conversations stored | **111** |
| Messages captured | **3,350** (965 from you, 2,371 from models) |
| Content stored | **2,089,878 characters** |
| Sync idempotency | Re-run added only genuinely new messages, no duplicates |
| Style measurement | 706 real messages analysed |
| Live capture | Autosync picked up 14 messages mid-session |

---

## How it works

### Reading session logs

The harness writes each session as a **concatenated Zstandard stream** — one
frame per appended batch. Node's one-shot `zstdDecompressSync` stops at the
first frame, which makes a 1.6 MB log look like it contains a single event.

`scripts/vault_reader.cjs` walks the frame boundaries structurally (the same
algorithm the harness's own `session-persistence-jsonl` backend uses) and
decompresses each frame independently. That is what turns 1.6 MB of log into
3,350 usable messages.

### Storage

SQLite at `kairoforge/.kairoforge/vault.sqlite`:

| Table | Holds |
| --- | --- |
| `conversations` | one row per session, with model and working directory |
| `messages` | every turn, with role, model, timestamp, content hash |
| `facts` | durable statements, with confidence and seen-count |
| `meta` | schema version |

Messages carry a `UNIQUE(conversation, turn, role)` constraint, which is what
makes re-syncing safe: replaying an old session inserts nothing.

### Injection

`integration/harness/plugin-vault.ts` registers a system-prompt section whose
text is evaluated per assembly. Two properties matter:

- **Bounded.** The block is capped (`maxCharacters`, default 4000). It is
  prepended to every request, so an unbounded block would eventually crowd out
  your actual message.
- **Best-effort.** If the vault, Python, or the CLI is unavailable, the section
  contributes nothing and the conversation proceeds. Memory that can break the
  assistant is worse than memory that is occasionally silent.

---

## Running it

### Capture automatically

```sh
cd kairoforge
nohup bash scripts/vault_autosync.sh >/dev/null 2>&1 &
```

Syncs immediately, then every 15 minutes. Already running in this workspace.

For a permanent install across reboots, add a launchd agent:

```xml
<!-- ~/Library/LaunchAgents/com.kairoforge.vault.plist -->
<key>ProgramArguments</key>
<array>
  <string>/bin/bash</string>
  <string>/path/to/kairoforge/scripts/vault_autosync.sh</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
```

### Commands

```sh
python3 scripts/vault_sync.py sync     # import new conversations
python3 scripts/vault_sync.py stats    # what the vault holds + your measured style
python3 scripts/vault_sync.py prompt   # the block a new conversation receives
python3 scripts/vault_sync.py export --out data/raw/vault-v1.jsonl
```

### Use it as a model

```sh
export KAIROFORGE_DIR=/path/to/kairoforge
python3 scripts/vault_sync.py export --out data/raw/vault-v1.jsonl
# then feed it through the normal pipeline and training
```

---

## Honest limits

**It does not make a model "think like you" by itself.** A prompt-shaped
memory block influences tone and register. Genuinely changing how a model
reasons requires training on your data — that is what the export path is for,
and it still needs GPU time to run.

**Style measurement is statistical, not psychological.** It counts words,
sentences, questions, and recurring terms. It describes how you *write*. It
does not infer intent, mood, or personality, and it should not be read as
doing so.

**The export filter matters.** Your raw vault contains harness scaffolding you
never typed and model output that leaked internal reasoning. Exporting
unfiltered would teach a model to emit `<system-reminder>` blocks and fake
`«internal_thinking»` traces. The exporter rejects those explicitly:

```
rejected: harness-context=43, leaked-reasoning=14, too-short=34
exported 217 clean pairs
```

**Storage grows.** 2 MB for ~3,350 messages. The vault keeps everything, so it
grows with use; SQLite handles this well into the millions of rows.

**Nothing is uploaded.** The vault is a local file. Only the small derived
profile leaves the machine, and only when a conversation is assembled.

---

## Privacy

The vault holds your complete conversation history in plaintext at
`kairoforge/.kairoforge/vault.sqlite`. That is the point — it is your memory —
but it means:

- anyone with filesystem access to that file can read every conversation;
- deleting it erases your memory permanently (back it up if it matters);
- if you export training pairs and train on them, that data influences model
  weights, which are harder to delete than a database row.

To start over: `rm .kairoforge/vault.sqlite` and re-sync from session logs.
To pause capture: `pkill -f vault_autosync`.
