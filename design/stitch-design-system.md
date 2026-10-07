---
name: Warm Henesys Tactile Modern
colors:
  surface: '#fff8f5'
  surface-dim: '#e1d8d4'
  surface-bright: '#fff8f5'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#fbf2ed'
  surface-container: '#f5ece7'
  surface-container-high: '#efe6e2'
  surface-container-highest: '#e9e1dc'
  on-surface: '#1e1b18'
  on-surface-variant: '#564338'
  inverse-surface: '#34302c'
  inverse-on-surface: '#f8efea'
  outline: '#8a7266'
  outline-variant: '#ddc1b3'
  surface-tint: '#9a4600'
  primary: '#9a4600'
  on-primary: '#ffffff'
  primary-container: '#ff8a3d'
  on-primary-container: '#682d00'
  inverse-primary: '#ffb68d'
  secondary: '#006496'
  on-secondary: '#ffffff'
  secondary-container: '#67bdff'
  on-secondary-container: '#004b73'
  tertiary: '#006d37'
  on-tertiary: '#ffffff'
  tertiary-container: '#5bbc79'
  on-tertiary-container: '#004822'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffdbc9'
  primary-fixed-dim: '#ffb68d'
  on-primary-fixed: '#321200'
  on-primary-fixed-variant: '#763300'
  secondary-fixed: '#cce5ff'
  secondary-fixed-dim: '#91cdff'
  on-secondary-fixed: '#001e31'
  on-secondary-fixed-variant: '#004b72'
  tertiary-fixed: '#95f7ae'
  tertiary-fixed-dim: '#79db94'
  on-tertiary-fixed: '#00210c'
  on-tertiary-fixed-variant: '#005228'
  background: '#fff8f5'
  on-background: '#1e1b18'
  surface-variant: '#e9e1dc'
typography:
  display-hero:
    fontFamily: Plus Jakarta Sans
    fontSize: 40px
    fontWeight: '800'
    lineHeight: 48px
    letterSpacing: -0.03em
  display-hero-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 30px
    fontWeight: '800'
    lineHeight: 38px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 28px
    fontWeight: '700'
    lineHeight: 36px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 22px
    fontWeight: '700'
    lineHeight: 28px
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.01em
  title-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 22px
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  label-pixel:
    fontFamily: Space Mono
    fontSize: 11px
    fontWeight: '700'
    lineHeight: 14px
    letterSpacing: 0.06em
  label-tabular:
    fontFamily: Space Mono
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: -0.01em
  label-ui:
    fontFamily: Plus Jakarta Sans
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.01em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-desktop: 1.5rem
  margin: 1rem
  margin-tablet: 1.5rem
  margin-desktop: 2.5rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2rem
---

<!-- Stitch 에서 내보낸 디자인 시스템 원본 (2026-10-07 받음). 코드 반영 내역은 DESIGN.md 참고 -->

## Brand & Style

This design system synthesizes the crisp, disciplined structure of modern personal productivity software with the comforting, nostalgic warmth of classic MMORPG pastoral hubs. It captures the tranquility of idling in a sunlit town: soft grass underfoot, warm terracotta roofs, and gentle ambient chime notes.

The target audience comprises digital-native professionals, students, and hobbyists who seek organized daily planning without sterile, clinical enterprise rigidity. The interface evokes a sense of comfort, gentle motivation, and tangible progress—transforming stressful scheduling and task backlogs into a cozy daily quest log.

Visually, the system operates as a hybrid:
- **Foundational Layout & Typography:** Contemporary, ultra-legible modern SaaS ergonomics with generous touch targets, clear typographic hierarchies, and fluid layout responsiveness.
- **Surface & Shape Language:** Soft, pillowy containers, gentle 1px warm borders, and warm neutral layered surfaces that feel like thick cream cardstock.
- **Micro-Delight:** Carefully metered pixel-art accents, crisp 8-bit inspired mini badges, and playful tactile feedback on interactions, without compromising serious multi-day calendar density.

## Colors

The palette is rooted in cozy, pastoral warmth. It avoids pure cold whites and harsh pitch blacks, adopting soft parchment tones and deep roasted espresso hues.

### Palette Architecture
- **Primary (Henesys Amber/Orange):** `#FF8A3D` serves as the primary action anchor, progress fill, and high-energy milestone focus. Deepened with `#E57328` for active hover/press states.
- **Secondary (Fair Sky Blue):** `#4FA8E8` provides refreshing contrast for non-urgent tasks, event category filters, and calendar month headers, paired with `#EBF5FC` as a sky tint container.
- **Tertiary (Meadow Green):** `#48A968` represents completions, streak milestones, and nature/health categories, paired with `#EBF7EE` for success backgrounds.
- **Warm Accents:** 
  - *Sunshine Gold:* `#FFD152` (subtle highlights, pinned items, `#FFF9E6` fills).
  - *Sweet Peach:* `#FF6B8B` (urgent priorities, personal health tags, `#FFEBF0` fills).
- **Neutrals & Surfaces:**
  - *Canvas Background:* `#FAF8F5`
  - *Surface Default:* `#FFFFFF`
  - *Surface Muted / Layer 2:* `#F5F1EB`
  - *Surface Border:* `#E8E2D8`
  - *Text Primary (Espresso Charcoal):* `#2D2926`
  - *Text Secondary (Warm Earth):* `#59534D`
  - *Text Muted (Clay):* `#8C847B`

### Color Usage Rules
- Avoid using pure `#000000` anywhere in the design. Deep espresso `#2D2926` maintains maximum contrast while preserving warmth.
- Tinted surfaces (`#EBF7EE`, `#EBF5FC`, `#FFF9E6`, `#FFEBF0`) are strictly dedicated to badges, tag pills, and low-contrast timeline appointment blocks.
- Interactive states use soft amber radiance rather than neon blue focus rings.

## Typography

The typography system pairs **Plus Jakarta Sans** for body copy and headings with **Space Mono** for timestamps, numeric indicators, and retro quest badges.

- **Plus Jakarta Sans:** Delivers geometric clarity softened by humanist curvatures. It provides immediate readability across complex daily calendars and todo listings while harmonizing with rounded cards.
- **Space Mono:** Evokes the nostalgic pixel-grid structure of retro role-playing games without sacrificing crisp rendering on high-DPI screens. It is strictly reserved for:
  - Todo completion counters (`03/07`).
  - Quest tags and category mini-badges (`EXP`, `MAIN`, `HABIT`).
  - Precise timeline schedule hour labels (`09:00 AM - 10:30 AM`).

### Rules for Application
- Headings use negative letter-spacing (`-0.01em` to `-0.03em`) for a solid, friendly presence.
- Badges using `label-pixel` should be styled in uppercase with a `0.06em` tracking boost to maximize character definition.
- Enable `font-variant-numeric: tabular-nums` for all time listings to ensure timeline rows stay vertically aligned.

## Layout & Spacing

The layout is built upon an 8pt base grid system designed for high responsiveness across Progressive Web App views (mobile screens, foldables, tablets, and desktop sidebars).

### Screen Layout Models
- **Mobile PWA Viewport (< 640px):** Single-column stack with dynamic viewport height sizing (`100dvh`). Uses a `margin` of `1rem` and safe-area insets at the base for an anchored floating dock navigation bar.
- **Tablet (640px - 1024px):** 6-column fluid grid. Layout separates into a mini-calendar navigation column (2 cols) and active daily timeline / task management space (4 cols).
- **Desktop (>= 1024px):** 12-column fixed-max layout (maximum width of 1280px) with `2.5rem` outer margins. 3 cols for side navigation & month overview, 5 cols for granular schedule timeline, and 4 cols for quest backlog/habits.

### Vertical Rhythm & Padding
- Cards and schedule blocks rely on `space-md` (16px) internal padding to maintain breathing space.
- Item groupings (e.g., related tasks within a project cluster) maintain an internal gap of `space-sm` (8px).
- Section breaks between calendar views, progress overviews, and habit modules use `space-xl` (32px).

## Elevation & Depth

This system avoids cold, blurry tech shadows, using instead warm, subtle ambient drops and layered parchment surfaces that feel grounded and tactile.

### Elevation Hierarchy
1. **Level 0 (Flat Ground):** `#FAF8F5`. The foundational canvas backdrop.
2. **Level 1 (Card & Section Surfaces):** `#FFFFFF` paired with a delicate outline: `border: 1px solid #E8E2D8`. Subtle depth is applied via:
   - `box-shadow: 0px 2px 0px #EFEAE1, 0px 4px 12px rgba(45, 41, 38, 0.03)`.
   This creates a pressed cardstock feel with a subtle physical lip.
3. **Level 2 (Timeline Blocks & Interactive Cards):**
   - Rest state: `box-shadow: 0px 2px 4px rgba(45, 41, 38, 0.04)`.
   - Hover / Active state: `box-shadow: 0px 4px 16px rgba(255, 138, 61, 0.12)`. Subtle orange ambient warmth lifts the component.
4. **Level 3 (Floating Action Button & Modals):**
   - Floating buttons and sheet overlays use:
   - `box-shadow: 0px 8px 24px rgba(45, 41, 38, 0.08), 0px 2px 0px rgba(45, 41, 38, 0.05)`.
5. **Level 4 (PWA Bottom Navigation Dock):**
   - Glass-card style: `background: rgba(255, 255, 255, 0.92); backdrop-filter: blur(12px)`.
   - Border: `1px solid #E8E2D8`.
   - Shadow: `0px 10px 30px rgba(45, 41, 38, 0.08)`.

## Shapes

The shape system balances soft, ergonomic card containers with crisp, miniature retro elements.

- **Main Containers & Cards:** Configured with `roundedness: 2` (equivalent to base radius of `16px` to `20px`). This provides an inviting, pillowy perimeter that keeps the UI friendly.
- **Pills & Status Tags:** Fully rounded pill-shapes (`9999px`) for category filters, status indicators, and streak markers.
- **Retro Pixel Touches:** 
  - Status markers, habit checkboxes, and mini icon chips incorporate a sharp step or 2px micro-chamfer on inner borders to suggest 8-bit styling, framed securely inside circular or rounded-lg containers.
  - Buttons and inputs feature rounded-xl (`12px` to `16px`) corners, preventing visual sharpness while retaining a modern SaaS silhouette.

## Components

### Buttons
- **Primary Action Button:**
  - Background: `#FF8A3D`, text `#FFFFFF`, border-radius `14px`, font weight `600`.
  - Border: 1px solid `#E57328`.
  - Under-edge accent: `box-shadow: 0 2px 0 #D4661E, 0 4px 10px rgba(255, 138, 61, 0.2)`.
  - Press state: Translates `1px` downward with reduced shadow for a tactile, game-like keypress.
- **Secondary Button:**
  - Background: `#FFFFFF`, text `#2D2926`, border `1px solid #E8E2D8`.
  - Hover: Background `#FAF8F5`, border-color `#D8D1C5`.
- **Icon Button:**
  - Rounded `12px`, 40x40px container, centered icon, subtle `#F5F1EB` background.

### Cards & Daily Schedule Blocks
- **Schedule Timeline Item:**
  - Background: Variable tint based on tag (e.g., `#EBF5FC` for Focus, `#FFF9E6` for Review).
  - Left border stripe: 4px solid category color (`#4FA8E8`, `#FFD152`, or `#48A968`).
  - Corner radius: `14px`.
  - Layout: `Space Mono` timestamp on top, `Plus Jakarta Sans` title beneath, with subtle tag pill.
- **Card Container:**
  - Background: `#FFFFFF`, 1px solid `#E8E2D8`, radius `18px`, padding `1.25rem`.

### Chips & Retro Pixel Badges
- **Tag Pill:**
  - Height: 24px, pill-shaped (`9999px`), padding `0 10px`.
  - Font: `Space Mono`, 11px uppercase bold.
  - Light pastel background matched with deep text tone (e.g., Background `#EBF7EE`, Text `#2F7A49`).
- **Retro Quest Badge:**
  - 18x18px inline square badge with 2px corner radius, showcasing low-res pixel mini-icons (e.g., sword, scroll, leaf, mushroom icon silhouette) for daily tasks.

### Checkboxes & Todo Rows
- **Custom Quest Checkbox:**
  - Dimensions: 22x22px, border-radius `6px`.
  - Unchecked: 2px solid `#D8D1C5`, background `#FFFFFF`.
  - Checked: Background `#48A968`, border `2px solid #3B8C55`. The checkmark is a crisp retro tick.
  - Action feel: Gentle scale bounce animation (`transform: scale(0.92)` to `scale(1.05)` to `scale(1.0)`) on check completion.
- **Todo Row:**
  - Flex layout with checkbox, title, dynamic mini-badge, and optional recurrence marker. On completion, text shifts to `#8C847B` with a warm diagonal strikethrough.

### Input Fields
- Background: `#FFFFFF`, border: `1.5px solid #E8E2D8`, radius `12px`, padding `10px 14px`.
- Text: `#2D2926`, placeholder: `#8C847B`.
- Focus State: Outline none, border-color `#FF8A3D`, box-shadow `0 0 0 3px rgba(255, 138, 61, 0.15)`.

### Cozy Progress Bars
- Height: 10px, background `#F0EAE1`, border-radius `9999px`, inner shadow `inset 0 1px 2px rgba(0,0,0,0.06)`.
- Fill: Grassy Green (`#48A968`) or Henesys Orange (`#FF8A3D`) with a rounded tip and a subtle dotted segment indicator for milestone steps.

### Navigation Dock (Mobile PWA)
- Floating dock positioned 16px above the viewport bottom, inset 16px from side edges.
- Radius: `24px`, background: `rgba(255, 255, 255, 0.95)`, backdrop-blur: `10px`.
- Border: `1px solid #E8E2D8`.
- Elevated with a soft shadow; items use warm icons with small active amber dots (`#FF8A3D`) centered beneath active tabs.
