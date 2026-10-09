# Security and privacy

CarryOn is a single-user loopback application. Keep it on your own computer; there is no account-based authentication for remote deployment.

Do not post chats, backups, screenshots with private content, credentials or machine-specific paths in issues. Use GitHub's private vulnerability reporting on this repository for suspected security defects. Include a minimal synthetic reproducer, affected version, and expected versus actual behavior.

The public release is assembled from a source whitelist with fresh Git history. Runtime data, credentials, logs, caches and historical private delivery notes are excluded. The tracked-file guard and a release-time Gitleaks scan check the public tree. These checks do not guarantee absence of every possible secret; contributors must inspect their own diff.

Model credentials stay in process memory. Imported chats can themselves contain secrets: a chat backup intentionally contains that body text, so keep exported backups private. The application does not globally censor programming examples that contain words such as `apiKey` or `Authorization`.

Deletion clears application-readable content and dependent outputs. Exported files and pre-restore snapshots remain under your control. The application does not promise secure erasure from disk, OS backups or model-provider retention.

The interface prevents automatic HTML/script execution and remote asset loading from chat content. AI output citations are structurally checked, but factual support and interpretation still need human review. Real-provider behavior is not certified by simulated protocol tests.
