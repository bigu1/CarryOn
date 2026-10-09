# 1.0.0-beta.3

Standardize the English product name as **CarryOn**, with **续上** as the Chinese name. The repository, package, page title, navigation, README, model prompts, service labels and screenshots use the same branding.

Copyright and commit attribution are corrected to the repository owner **bigu1**, using the account's GitHub-provided privacy email. The previous generic contributor identity was release setup metadata, not evidence of another person's participation.

Existing database filenames, backup format identifiers, cookies and `XUSHANG_*` settings are retained for compatibility. No private library is read or migrated for the rename. Source, tracked files, public history, screenshots and release assets are rechecked for privacy; see [the audit](PRIVACY_AUDIT.md).

Validation retains the 81 integration and 14 browser tests, build, type checks and isolated synthetic data. Real-provider quality and private-chat value remain unverified.

# 1.0.0-beta.2

Follow-up review fixes exact selection and citation jumps when Chinese or emoji excerpts repeat inside a message. Selected code-point offsets are checked by the server and carried by links; ambiguous model excerpts are rejected instead of silently pointing to the first occurrence.

Search return links retain topic, role, date filters and pagination. Invalid UTF-8 uploads are rejected explicitly. Model response content and answer structure are validated, with individual tests for authentication failure, rate limits, timeouts, empty or malformed responses, oversized output and bounded retries.

Validation includes 81 integration tests, 14 Chromium browser tests, actual clipboard comparisons, three populated viewport screenshots and an isolated macOS restart that preserved sources, cards, revisions, citations, replacements and handoffs exactly while clearing runtime credentials. See [the item-by-item matrix](ACCEPTANCE_MATRIX.md).

Real model quality and usefulness on private chats remain unverified. This is a public source release under MIT; the application still runs on loopback only.

# 1.0.0-beta.1

First public source release: rebuilt component-based interface, separated server routes, no-model workflows and independent regressions for deletion, backup, role correction, historical citations, scope preview, model limits and instance ownership. The public repository uses fresh history and excludes personal data and previous private commits.
