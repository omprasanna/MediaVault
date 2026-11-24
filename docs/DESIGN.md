# MediaVault Design System (`docs/DESIGN.md`)

Extracted from the Stitch MediaVault project (`MediaVault Downloader Dashboard`, `projects/5155593898828555213`) across three reference screens:
- **Dark Mode Desktop:** *MediaVault — Minimalist Media Downloader* (`screens/ff87cc8ee52c49aeabac40126a38972e`, `web_standard`)
- **Light Mode Desktop:** *MediaVault — Minimalist Media Downloader (Light Mode)* (`screens/6288f445399b48d7bb7424843b021f3a`, `web_standard`)
- **Mobile (390px):** *MediaVault — Mobile Downloader* (`screens/4cc6f47039834a22b75ea28b219ebf6e`, `mobile_tab`)

---

## 1. Overview & Aesthetic Principles

MediaVault uses a Linear-inspired minimalist developer utility aesthetic built for high-density scanability, low visual fatigue, and deterministic telemetry:
- **Crisp hairline divisions & flat tonal layering:** Avoid decorative shadows and heavy gradients; separate panels and controls using `1px` borders and subtle surface stepping.
- **Dual-theme parity (`.dark` default / `.light`):** Both themes preserve identical spatial rhythm, radii, and status semantics while inverting canvas and zinc surface tiers.
- **Strict CSS token discipline:** **All color values MUST be defined exclusively as CSS custom properties inside `client/src/app/globals.css`.** React components, Tailwind classes, and inline styles must reference semantic tokens (`var(--...)` or Tailwind v4 `@theme inline` tokens) and **must never hardcode raw hex values** (`#...`).

---

## 2. Semantic CSS Variable Tokens (Dark & Light Themes)

### 2.1 Token Comparison Matrix

| Token | Category | Light Theme (`:root` / `.light`) | Dark Theme (`.dark`) | Usage |
| :--- | :--- | :--- | :--- | :--- |
| `--bg-canvas` | Canvas | `#FFFFFF` | `#131315` | Page root background, sticky header & mobile bottom bar backdrop |
| `--bg-surface` | Surface | `#F4F4F5` | `#1C1B1D` | Primary section cards (URL input wrapper, media inspect card, active job bar) |
| `--bg-surface-elevated` | Surface | `#FFFFFF` | `#201F22` | Supported platform chips, metadata badges, nested option containers |
| `--bg-surface-high` | Surface | `#ECECEE` | `#2A2A2C` | Active segmented nav/mode tab, mobile paste button, secondary hover |
| `--bg-surface-highest` | Surface | `#E4E4E7` | `#353437` | Progress bar tracks, unchecked switch tracks, version badge fill (mobile) |
| `--bg-surface-recessed` | Surface | `#FFFFFF` | `#0E0E10` | URL input inner well, desktop nav pill track, media thumbnail backdrop, footer |
| `--bg-surface-hover` | Surface | `#FAFAFA` | `#39393B` | Subtle table striping / hover lift |
| `--border-subtle` | Border | `#E4E4E7` | `rgba(66, 71, 84, 0.35)` | Card header/footer hairlines, section dividers, sticky bar borders |
| `--border-default` | Border | `#E4E4E7` | `#424754` | Default card outlines, buttons, chip borders, segmented controls |
| `--border-strong` | Border | `#D4D4D8` | `#8C909F` | Interactive hover borders, unchecked radio/checkbox rings |
| `--text-primary` | Text | `#09090B` | `#E5E1E4` | Headings, active labels, input text, file sizes, primary body |
| `--text-secondary` | Text | `#52525B` | `#C2C6D6` | Supporting labels, channel metadata, codec descriptors, inactive nav text |
| `--text-muted` | Text | `#71717A` | `#8C909F` | Placeholders (light `#A1A1AA`), section eyebrow labels, muted icons, timestamps |
| `--accent-primary` | Accent Blue | `#3B82F6` | `#4D8EFF` | Primary CTA background, active format card border, progress fill, active switch track |
| `--accent-primary-hover` | Accent Blue | `#2563EB` | `#3B82F6` | Primary CTA hover fill |
| `--accent-primary-active` | Accent Blue | `#1D4ED8` | `#2563EB` | Primary CTA active press state |
| `--accent-primary-text` | Accent Blue | `#2563EB` | `#ADC6FF` | Text links (`View Queue`), active mobile tab icon/label, queue badge text |
| `--accent-on-primary` | Accent Blue | `#FFFFFF` | `#002E6A` | Foreground text/icon on primary-container fills (`#FFFFFF` on `#3B82F6` fills) |
| `--accent-primary-soft` | Accent Blue | `#EFF6FF` | `rgba(77, 142, 255, 0.12)` | Selected format card background, queue count badge fill |
| `--accent-primary-border` | Accent Blue | `#BFDBFE` | `rgba(173, 198, 255, 0.30)` | Accent pill/badge borders, selected card divider tint |
| `--accent-focus-ring` | Focus | `rgba(59, 130, 246, 0.25)` | `rgba(77, 142, 255, 0.45)` | Input & control focus ring shadow |
| `--status-ready` | Ready | `#059669` | `#4EDEA3` | Ready status text, `Instant Stream` badge, online node label, verified check icon |
| `--status-ready-dot` | Ready | `#10B981` | `#4EDEA3` | Live node indicator dot |
| `--status-ready-bg` | Ready | `#ECFDF5` | `rgba(78, 222, 163, 0.15)` | Ready / Instant Stream pill surface |
| `--status-ready-border` | Ready | `#A7F3D0` | `rgba(78, 222, 163, 0.30)` | Ready / Instant Stream pill border |
| `--status-muxing` | Muxing | `#D97706` | `#FFB95F` | Muxing / Downloading / Processing status indicator & percentage telemetry |
| `--status-muxing-dot` | Muxing | `#F59E0B` | `#FFB95F` | Pulsing active job dot |
| `--status-muxing-bg` | Muxing | `#FFFBEB` | `rgba(255, 185, 95, 0.15)` | Muxing status badge background |
| `--status-muxing-border` | Muxing | `#FDE68A` | `rgba(255, 185, 95, 0.30)` | Muxing status badge border |
| `--status-failed` | Failed | `#DC2626` | `#FFB4AB` | Failed job status, destructive actions, YouTube platform pill accent |
| `--status-failed-dot` | Failed | `#EF4444` | `#FFB4AB` | Error indicator dot |
| `--status-failed-bg` | Failed | `#FEF2F2` | `rgba(147, 0, 10, 0.28)` | Failed job pill / danger button surface |
| `--status-failed-border` | Failed | `#FECACA` | `rgba(255, 180, 171, 0.30)` | Failed job pill / danger button border |

### 2.2 Canonical `globals.css` Token Definition

Define all tokens solely inside `client/src/app/globals.css` and expose them to Tailwind CSS v4 via `@theme inline`:

```css
@import "tailwindcss";

:root,
.light {
  --bg-canvas: #ffffff;
  --bg-surface: #f4f4f5;
  --bg-surface-elevated: #ffffff;
  --bg-surface-high: #ececee;
  --bg-surface-highest: #e4e4e7;
  --bg-surface-recessed: #ffffff;
  --bg-surface-hover: #fafafa;

  --border-subtle: #e4e4e7;
  --border-default: #e4e4e7;
  --border-strong: #d4d4d8;

  --text-primary: #09090b;
  --text-secondary: #52525b;
  --text-muted: #71717a;
  --text-placeholder: #a1a1aa;

  --accent-primary: #3b82f6;
  --accent-primary-hover: #2563eb;
  --accent-primary-active: #1d4ed8;
  --accent-primary-text: #2563eb;
  --accent-on-primary: #ffffff;
  --accent-primary-soft: #eff6ff;
  --accent-primary-border: #bfdbfe;
  --accent-focus-ring: rgba(59, 130, 246, 0.25);

  --status-ready: #059669;
  --status-ready-dot: #10b981;
  --status-ready-bg: #ecfdf5;
  --status-ready-border: #a7f3d0;

  --status-muxing: #d97706;
  --status-muxing-dot: #f59e0b;
  --status-muxing-bg: #fffbeb;
  --status-muxing-border: #fde68a;

  --status-failed: #dc2626;
  --status-failed-dot: #ef4444;
  --status-failed-bg: #fef2f2;
  --status-failed-border: #fecaca;

  --shadow-xs: 0 1px 2px 0 rgba(9, 9, 11, 0.04);
  --shadow-overlay: 0 4px 12px -2px rgba(9, 9, 11, 0.05), 0 2px 4px -2px rgba(9, 9, 11, 0.03);
  --shadow-dock: 0 1px 3px 0 rgba(9, 9, 11, 0.06);
}

.dark {
  --bg-canvas: #131315;
  --bg-surface: #1c1b1d;
  --bg-surface-elevated: #201f22;
  --bg-surface-high: #2a2a2c;
  --bg-surface-highest: #353437;
  --bg-surface-recessed: #0e0e10;
  --bg-surface-hover: #39393b;

  --border-subtle: rgba(66, 71, 84, 0.35);
  --border-default: #424754;
  --border-strong: #8c909f;

  --text-primary: #e5e1e4;
  --text-secondary: #c2c6d6;
  --text-muted: #8c909f;
  --text-placeholder: #8c909f;

  --accent-primary: #4d8eff;
  --accent-primary-hover: #3b82f6;
  --accent-primary-active: #2563eb;
  --accent-primary-text: #adc6ff;
  --accent-on-primary: #002e6a;
  --accent-primary-soft: rgba(77, 142, 255, 0.12);
  --accent-primary-border: rgba(173, 198, 255, 0.3);
  --accent-focus-ring: rgba(77, 142, 255, 0.45);

  --status-ready: #4edea3;
  --status-ready-dot: #4edea3;
  --status-ready-bg: rgba(78, 222, 163, 0.15);
  --status-ready-border: rgba(78, 222, 163, 0.3);

  --status-muxing: #ffb95f;
  --status-muxing-dot: #ffb95f;
  --status-muxing-bg: rgba(255, 185, 95, 0.15);
  --status-muxing-border: rgba(255, 185, 95, 0.3);

  --status-failed: #ffb4ab;
  --status-failed-dot: #ffb4ab;
  --status-failed-bg: rgba(147, 0, 10, 0.28);
  --status-failed-border: rgba(255, 180, 171, 0.3);

  --shadow-xs: 0 1px 2px 0 rgba(0, 0, 0, 0.25);
  --shadow-overlay: 0 4px 12px rgba(0, 0, 0, 0.5);
  --shadow-dock: 0 20px 25px -5px rgba(0, 0, 0, 0.45), 0 8px 10px -6px rgba(0, 0, 0, 0.35);
}

@theme inline {
  --color-canvas: var(--bg-canvas);
  --color-surface: var(--bg-surface);
  --color-surface-elevated: var(--bg-surface-elevated);
  --color-surface-high: var(--bg-surface-high);
  --color-surface-highest: var(--bg-surface-highest);
  --color-surface-recessed: var(--bg-surface-recessed);
  --color-surface-hover: var(--bg-surface-hover);

  --color-border-subtle: var(--border-subtle);
  --color-border-default: var(--border-default);
  --color-border-strong: var(--border-strong);

  --color-ink-primary: var(--text-primary);
  --color-ink-secondary: var(--text-secondary);
  --color-ink-muted: var(--text-muted);

  --color-accent: var(--accent-primary);
  --color-accent-hover: var(--accent-primary-hover);
  --color-accent-text: var(--accent-primary-text);
  --color-on-accent: var(--accent-on-primary);
  --color-accent-soft: var(--accent-primary-soft);
  --color-accent-border: var(--accent-primary-border);

  --color-ready: var(--status-ready);
  --color-ready-bg: var(--status-ready-bg);
  --color-ready-border: var(--status-ready-border);
  --color-muxing: var(--status-muxing);
  --color-muxing-bg: var(--status-muxing-bg);
  --color-muxing-border: var(--status-muxing-border);
  --color-failed: var(--status-failed);
  --color-failed-bg: var(--status-failed-bg);
  --color-failed-border: var(--status-failed-border);
}
```

---

## 3. Typography Scale (`Inter` + `JetBrains Mono`)

MediaVault bifurcates typography between UI structure and machine telemetry:
1. **`Inter` (`--font-sans`):** Navigation links, headings, card titles, form labels, mode switchers, and button copy. Weights stay at `500` (Medium) and `600` (SemiBold) with tight negative tracking on headings.
2. **`JetBrains Mono` (`--font-mono`):** Media URLs, durations (`12:48`), resolution/codec tags (`AVC1 / AAC · 60fps`), file sizes (`est. 142 MB`), transfer speeds (`14.2 MB/s`), progress percentages (`78%`), latency (`340ms`), version tags (`v2.4.0`), queue count pills, and timestamps.

> **Tabular Numerals Rule:** Every numeric telemetry value (progress `%`, `MB/s` speed, ETA, file sizes, durations, counts) **must** apply `font-variant-numeric: tabular-nums` (Tailwind `tabular-nums`) so values update smoothly during 2.5s job polling without horizontal layout shift.

| Token | Font Family | Size | Line Height | Weight | Letter Spacing | Usage |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `headline-xl` | `Inter` | `32px` | `40px` | `600` | `-0.02em` | Auth / hero page titles |
| `headline-lg` | `Inter` | `24px` | `32px` | `600` | `-0.015em` | View headers (`Queue & History`, `Settings`) |
| `headline-md` | `Inter` | `18px` | `24px` | `600` | `-0.01em` | Section headers, modal titles |
| `headline-sm` | `Inter` | `14px` | `20px` | `600` | `-0.005em` | Brand title (`MediaVault`), media title, format card title |
| `body-lg` | `JetBrains Mono` | `15px` | `22px` | `400` | `-0.01em` | Large technical inputs / summaries |
| `label-md` | `Inter` | `13px` | `16px` | `500` | `0em` | Top nav links, buttons, mode switcher tabs, helper rows |
| `body-md` | `JetBrains Mono` | `13px` | `18px` | `400` | `0em` | URL input text, file sizes in format cards, table cells |
| `code-inline` | `JetBrains Mono` | `12px` | `16px` | `500` | `0em` | Platform chips, codec tags, `Fast Mux`/`Instant Stream` badges |
| `label-sm` | `Inter` | `11px` | `14px` | `500` | `0.02em` | Uppercase eyebrows (`EXTRACTION FORMAT`), mobile tab labels |
| `body-sm` | `JetBrains Mono` | `11px` | `16px` | `400` | `0em` | Version pill, latency, duration pill, progress `%`, footer meta |

---

## 4. Radii, Spacing, Borders & Shadow Rules

### 4.1 Border Radii
| Token | Value | Tailwind Class | Applied To |
| :--- | :--- | :--- | :--- |
| `--radius-sm` | `2px` | `rounded-sm` | Micro hairlines & tight inline highlights |
| `--radius-badge` | `4px` | `rounded` | Platform tags, codec specs (`AVC1 / AAC`), duration badges, version pill |
| `--radius-control` | `8px` | `rounded-lg` | URL input box, buttons, segmented switcher tabs, format cards, icon buttons |
| `--radius-panel` | `12px` | `rounded-xl` | Top-level URL input card, media inspection card, docked active job bar, mobile sticky CTA |
| `--radius-pill` | `9999px` | `rounded-full` | Nav container, status badges, node online pill, toggle switches, user avatar |

### 4.2 Spacing & Container Rhythm
Base increment is **4px** (`0.25rem`) with an **8px** component grid:
- `space-xs`: `4px` (`0.25rem`) — inline icon/text gaps, pill clusters
- `space-sm`: `8px` (`0.5rem`) — button groups, format grid gap (`gap-2` / `0.5rem`), input padding
- `space-md`: `16px` (`1rem`) — mobile edge margin (`margin-mobile`), standard card padding (`14px`–`16px`), section vertical spacing
- `space-lg`: `24px` (`1.5rem`) — desktop page horizontal margin (`margin`), inter-card vertical gap
- `space-xl`: `32px` (`2rem`) — macro view spacing
- **Max widths:** Header container `max-w-7xl` (`1280px`); main downloader workspace `max-w-4xl` (`896px`).

### 4.3 Borders & Elevation / Shadows
- **Default containers:** `1px solid var(--border-default)` (or `--border-subtle` for internal horizontal dividers).
- **Selected format card:** `2px solid var(--accent-primary)` with `--accent-primary-soft` background and subtle ring (`0 0 0 1px var(--accent-primary-border)`).
- **Focus rings:** Strict `1px solid var(--accent-primary)` border + `0 0 0 2px var(--accent-focus-ring)` outer ring — never apply colored neon drop glows.
- **Shadows:** Kept structural and minimal (`--shadow-xs` on Light cards/inputs, `--shadow-overlay` on floating menus, `--shadow-dock` on the docked active job bar).
- **Component density benchmarks:**
  - Desktop buttons & text inputs: `32px`–`36px` (`h-8` / `h-9`); URL well `py-2`; data table rows `36px` (`h-9`).
  - Mobile touch targets: `>= 44px` height/width (`min-h-[44px]` bottom tabs, `h-11` URL input, `h-12` paste button, `h-[50px]` primary CTA).

---

## 5. Responsive Navigation & Layout: Desktop vs. Mobile (`390px`)

MediaVault splits shell navigation cleanly at the `md` (`768px`) breakpoint:

| Aspect | Desktop (`>= 768px`, `web_standard`) | Mobile (`< 768px` / `390px`, `mobile_tab`) |
| :--- | :--- | :--- |
| **Top Bar** | Fixed `h-14` (`56px`), `max-w-7xl` centered, `backdrop-blur-md`, `1px` bottom border | Compact fixed `h-12` (`48px` + `env(safe-area-inset-top)`), `backdrop-blur-xl` |
| **Top Bar Left** | Brand icon + `MediaVault` (`14px` SemiBold) + `v2.4.0` mono badge | Lock icon + `MediaVault` + compact `10px` `v2.4.0` badge |
| **Primary Navigation** | Centered pill switcher in top bar: `Downloader`, `Queue & History` (with count pill), `Settings` | **Fixed Bottom Tab Bar** (`h-14` + `env(safe-area-inset-bottom)`, `z-50`) with 3 `min-w-[64px] min-h-[44px]` tabs: `Downloader`, `Queue` (floating count badge), `Settings`, plus active dot indicator |
| **Top Bar Right** | `Local Node (Online · 127.0.0.1)` status pill, Theme Toggle (`32×32px`), Logout/Power icon (`32×32px`), User Avatar (`32×32px`) | Compact `Local Node` dot pill (no IP text), circular Theme Toggle (`32×32px`), User Avatar (`32×32px`); logout/account actions live in Settings |
| **URL Input Section** | Single horizontal row: link icon + URL input + inline `Paste` & `Inspect` buttons | Stacked layout: `h-11` URL input with clear (`×`) button on top + full-width `h-12` `Paste from Clipboard` button below |
| **Platform & Cookies Row** | Full platform pills (`YouTube`, `YT Music`, `Instagram`, `X`, `Facebook`, `Dailymotion`) + full toggle label | Abbreviated horizontally scrollable pills (`YT`, `IG`, `X`, `FB`, `DM`) + concise `Cookies` switch |
| **Media Result Header** | Horizontal split: `210×118px` thumbnail left + metadata & tags right | Vertical stack: full-width `aspect-video` preview top + metadata block below |
| **Mode & Format Grid** | Inline `Extraction Format` label + segmented mode toggle; **2×2 grid** (`md:grid-cols-2`) | Full-width 2-column mode toggle (`h-9`); **1-column stacked** format radio cards |
| **Primary Download CTA** | Right-aligned inside media card footer alongside lossless stream-copy verification text | **Sticky bottom bar** (`h-[50px]`, `rounded-xl`) anchored above the bottom tab bar with `pb-24`/`pb-28` main clearance |
| **Active Job Indicator** | Full-width docked horizontal bar (`Active Job`, progress bar + `%`, `MB/s`, pause, `View Queue (N)`) | Compact single-row pill (`dot`, truncated filename + `%`, thin progress bar, `Queue (N) ->`) |
| **Footer** | Compact utility footer (`MediaVault Daemon · Local Storage Sandbox` + quick links) | Omitted (replaced by fixed bottom tab bar) |
