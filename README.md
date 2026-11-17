# Realm Studio Plus

> Forked from https://github.com/realm/realm-studio

Realm Studio Plus is the tool, any developer or system administrator would use when building and maintaining their app built on the Realm Mobile Platform.

Realm Studio Plus ensures that existing **Realm Studio** installations remain operational in anticipation of the end of support for the original version, while also offering enhanced features.

## New Features Added to Realm Studio Plus

- Fix: Added compatibility with the latest operating systems (+ support for macOS Arm builds)
- Fix: Improved performance and fixed security issues through the latest module updates
- Fix: Removed code related to Realm Atlas Sync; removed the deprecated Realm Web API
- Feat: List of recently opened files
- Feat: Reload when data files are regenerated (improved "Watch file" functionality)
- Feat: Carbon Obsidian Dark Mode (default), selectable under **View → Appearance** (Match System / Light / Dark)
- Feat: **Navigation Bar** with Back/Forward history (`⌘[` / `⌘]`, Mouse Back/Forward) and interactive **Breadcrumbs** with automatic Smart ID extraction & 1-click Copy ID
- Feat: **Smart Quick Search** (plain-text search across string/numeric/ObjectId/UUID columns alongside full RQL support), **Recent & Bookmarked Queries (`★`)**, and **`⌘F`** shortcut
- Feat: **Global Search Across All Classes (`⌘⇧F`)** and **Command Palette (`⌘P`)**
- Feat: **Sidebar Class Filter (`⌘K`)**, **Pinned/Favorite Classes (`★`)**, and right-click **`Delete Class`** (`realm.deleteModel`)
- Feat: **Power Right-Click Context Menu**: `Filter by Value`, `Exclude Value`, `Copy Cell Value`, `Copy Row(s) as JSON`, `Compare 2 Selected Rows (Diff)`, `Inspect / Edit Row as JSON`, `Find References / Backlinks`, `Duplicate Row`, `Bulk Update Selected Rows`, and `Paste / Import JSON Rows`
- Feat: **Binary `Data` Cell Inspector** (Hex / UTF-8 / Base64 preview, Save to file, Load from file)
- Feat: **Column Header Statistics & Actions** (`Min`, `Max`, `Sum`, `Average`, `Top Distinct Values`, `Copy Column Values`, `Hide Column`) and **Column Visibility Toggle (`Columns`)**
- Feat: **Encryption Key Vault & Auto-Unlock** (remembers 128-hex encryption keys per path/filename and unlocks automatically)
- Feat: **Database Overview, Storage & Schema Code Preview** (`TypeScript`, `Swift`, `Kotlin`, `JavaScript`, `C#`, `Java`), **`Compact Database`**, **`Quick Backup`**, **`Save Decrypted Copy`**, **`Save Encrypted Copy`**, and **`Reveal in Finder`**
- Feat: **iOS Simulator `.realm` Auto-Finder**, **Android Emulator (ADB) `.realm` Puller & Auto-Sync**, **Drag & Drop File Open**, **Mock Data Generator (10/50/100 rows)**, and **Export Current View (JSON / CSV)**
- Feat: **Unlimited Split View (`⌘\` / `⌘⇧\`)** with drag-to-dock / swap panes and high-performance memoized rendering
- Feat: **Smart AI Assistant (`⌘⇧A`) & Optional Local AI (Ollama)** for cross-class ID lookup, RQL query generation, Schema Advisor, and Domain Knowledge Base
- Feat: **Built-in Read-Only MCP Server** for inspecting live Realm databases from AI coding assistants

This repository is actively maintained. That's because I'm the one using it :) We also actively incorporate your pull requests.

## Settings

User preferences are stored as a plain JSON file in the user data directory, and can be edited by hand — the app picks up changes without a restart. **View → Show Settings File** reveals it in the file manager.

| Platform | Location                                                        |
| -------- | --------------------------------------------------------------- |
| macOS    | `~/Library/Application Support/Realm Studio Plus/settings.json` |
| Linux    | `~/.config/Realm Studio Plus/settings.json`                     |
| Windows  | `%APPDATA%\Realm Studio Plus\settings.json`                     |

```json
{
  "theme": "system"
}
```

| Key | Values | Default | Description |
| --- | --- | --- | --- |
| `theme` | `system` \| `light` \| `dark` | `"system"` | `system` follows the operating system's own appearance. |

Below is the `README.md` file from the original repository.

Visit https://docs.mongodb.com/realm/studio/ for more information on Realm Studio.

## Installing

Click the links below to download the latest version of Realm Studio for

https://github.com/MassMack/realm-studio-ultimate/releases

## Code of Conduct

See [CODE_OF_CONDUCT.md](https://github.com/MassMack/realm-studio-ultimate/blob/master/CODE_OF_CONDUCT.md) for more details

## Developing and contributing

See [CONTRIBUTING.md](https://github.com/MassMack/realm-studio-ultimate/blob/master/docs/CONTRIBUTING.md) for more details!

## License

Realm Studio is published under [the Apache 2.0 license](LICENSE).

Realm Studio Plus is a fork of the original Realm Studio. This project also inherits the license of the original project.
