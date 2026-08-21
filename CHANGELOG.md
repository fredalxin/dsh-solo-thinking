# Changelog

All notable changes to this project are documented here.

## Unreleased

- Preserve returned branch Sessions until plugin shutdown so DSH can commit each tool result before the branch becomes read-only.
- Add `thinking_end`, `/thinking end`, and UI controls to clear an active tree while preserving its historical Sessions and Handoffs.

## 0.1.18 - 2026-08-15

- Add one-line macOS/Linux and Windows installers backed by the latest GitHub Release tarball.
- Add a transparent, pinned GitHub tag installation path that uses the official DSH CLI directly.
- Register the complete thinking-tree companion as an optional Better Sidebar tab and focus it when a session first starts brainstorming.
- Declare Better Sidebar as an optional peer and install both profile bundles from the one-line installers.
- Add the compact sidebar legend, selected-node split control, and collapsible parent/current/sibling/child context ladder.
- Let the sidebar tree fill all remaining pane height with its four context drawers collapsed by default, and add sibling/child conclusions to the full fallback tab.
- Render every Handoff with DSH's safe Markdown renderer in both the full view and Better Sidebar.
- Align the optional sidebar integration with DSH service replacement: consume the published contract, unwind subscriptions and caches, and re-register against a replacement provider.
- Prepare the package for the public npm registry while keeping Better Sidebar a soft runtime integration.

## 0.1.17 - 2026-08-14

- Add the Solo-style right-side thinking tree for patched DSH hosts.
- Keep suggested branches dormant until their first real message.
- Preserve the parent Workspace for all generated branch Sessions.
- Route branch messages without navigating away from the main Session.
- Automate split, checkpoint, sibling-awareness, and return Handoffs.
- Restore plugin state safely after a cold DSH restart.
- Verify the complete lifecycle against a controlled end-to-end provider.
