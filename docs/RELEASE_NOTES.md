# 1.0.0-beta.2

Follow-up review fixes exact selection and citation jumps when Chinese or emoji excerpts repeat inside a message. Selected code-point offsets are checked by the server and carried by links; ambiguous model excerpts are rejected instead of silently pointing to the first occurrence.

Search return links retain topic, role, date filters and pagination. Invalid UTF-8 uploads are rejected explicitly. Model response content and answer structure are validated, with individual tests for authentication failure, rate limits, timeouts, empty or malformed responses, oversized output and bounded retries.

Validation includes 81 integration tests, 14 Chromium browser tests, actual clipboard comparisons, three populated viewport screenshots and an isolated macOS restart that preserved sources, cards, revisions, citations, replacements and handoffs exactly while clearing runtime credentials. See [the item-by-item matrix](ACCEPTANCE_MATRIX.md).

Real model quality and usefulness on private chats remain unverified. This is a public source release under MIT; the application still runs on loopback only.

# 1.0.0-beta.1

First public source release: rebuilt component-based interface, separated server routes, no-model workflows and independent regressions for deletion, backup, role correction, historical citations, scope preview, model limits and instance ownership. The public repository uses fresh history and excludes personal data and previous private commits.
